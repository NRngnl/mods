// Detail-view actions: merge, approve, and open the PR's branch as a worktree tab in its project space.
// Everything runs on the PR list's machine, with that machine's gh and git.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, exec, run, openOverlay, shared } from "herdr";
import { toggleDiff } from "./diff.js";
import { agentsSection } from "./agents.js";
import { loadChecks, failedCount } from "./checks.js";

const METHODS = [
  ["squashMergeAllowed", "squash", "Squash"],
  ["mergeCommitAllowed", "merge", "Merge"],
  ["rebaseMergeAllowed", "rebase", "Rebase"],
];

// Reuses a worktree already on the branch (else adds <repo>-pr-<n> beside the checkout),
// then fast-forwards it to the PR head; local commits or edits are left alone.
const WORKTREE = `set -e
cd "$1"; top=$(git rev-parse --show-toplevel); b="$2"; n="$3"
# Forget worktrees whose folder another app already deleted, so they are not reused.
git worktree prune
wt=$(git worktree list --porcelain | awk -v r="refs/heads/$b" '/^worktree /{p=substr($0,10)} $0=="branch "r{print p; exit}')
fetch() { if [ "$4" = true ]; then git fetch -q origin "pull/$n/head"; else git fetch -q origin "$b"; fi; }
if [ "$5" = find ]; then
  # path, then "ahead behind dirty" against the PR head (fetched now, so the counts are current)
  [ -z "$wt" ] && exit 0
  fetch; head=$(git rev-parse FETCH_HEAD)
  set -- $(git -C "$wt" rev-list --left-right --count "HEAD...$head")
  dirty=$(git -C "$wt" status --porcelain --untracked-files=no | wc -l | tr -d " ")
  printf '%s\\n%s %s %s' "$wt" "$1" "$2" "$dirty"; exit 0
fi
fetch; head=$(git rev-parse FETCH_HEAD)
if [ -z "$wt" ]; then
  [ "$5" = sync ] && { echo "worktree no longer exists" >&2; exit 1; }
  # Where the app's own worktree mod puts them, so its Open worktree and sidebar see it too.
  wt="$HOME/.herdr/worktrees/$(basename "$top")/$(printf %s "$b" | tr / -)"
  mkdir -p "$(dirname "$wt")"
  if git show-ref -q --verify "refs/heads/$b"; then git worktree add -q "$wt" "$b"
  else git worktree add -q -b "$b" "$wt" "$head"; [ "$4" = true ] || git -C "$wt" branch -q -u "origin/$b"; fi
fi
if git -C "$wt" merge -q --ff-only "$head" >/dev/null 2>&1; then note="up to date"; else note="not updated (local changes or diverged)"; fi
set -- $(git -C "$wt" rev-list --left-right --count "HEAD...$head")
dirty=$(git -C "$wt" status --porcelain --untracked-files=no | wc -l | tr -d " ")
printf '%s\\n%s\\n%s %s %s' "$wt" "$note" "$1" "$2" "$dirty"`;

const repoOf = url => url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?\/?$/)?.[1]?.toLowerCase();

async function check(r, what) {
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim() || "failed"}`);
  return r.stdout.trim();
}

// A space matches when its start folder or any of its terminals' live folders is a checkout of
// the repo (a space started at home and cd'd into the repo has an empty folder). Returns
// { space, folder } with the matching checkout.
async function projectSpace(repo, on) {
  for (const s of spaces().filter(s => (s.machine ?? null) === on)) {
    const tabs = new Set(s.tabs.map(t => t.id));
    const folders = new Set(
      [
        s.folder,
        ...panes()
          .filter(p => tabs.has(p.tab))
          .map(p => p.cwd),
      ].filter(Boolean),
    );
    for (const folder of folders) {
      const r = await exec("git", ["-C", folder, "remote", "get-url", "origin"], { on }).catch(() => null);
      if (r?.code === 0 && repoOf(r.stdout.trim()) === repo.toLowerCase()) return { space: s, folder };
    }
  }
  throw new Error(`No space on ${on ?? "local"} is a checkout of ${repo}`);
}

async function worktree(pr, on, mode) {
  const { space, folder } = await projectSpace(pr.repository.nameWithOwner, on);
  const branch = pr.isCrossRepository ? `pr-${pr.number}` : pr.headRefName;
  const args = ["-c", WORKTREE, "wt", folder, branch, String(pr.number), String(pr.isCrossRepository), mode];
  return { space, out: await check(await exec("sh", args, { on }), "worktree") };
}

// The PR's worktree path on disk, or null. Local git only, no network.
// The PR's worktree on disk with how it compares to the PR head, or null.
const parseCounts = (path, counts) => {
  const [ahead, behind, dirty] = counts.split(" ").map(Number);
  return { path, ahead, behind, dirty };
};

export const findWorktree = (pr, on) =>
  worktree(pr, on, "find").then(
    ({ out }) => (out ? parseCounts(...out.split("\n")) : null),
    () => null,
  );

async function syncWorktree(view, pr, on) {
  const [path, note, counts] = (await worktree(pr, on, "sync")).out.split("\n");
  view.wt = { url: pr.url, ...parseCounts(path, counts) };
  return `Synced: ${note}`;
}

// `agent`: a knownAgents() entry to start there, or null for a shell.
async function openWorktree(view, pr, on, agent = null) {
  const [wt, note, counts] = (await worktree(pr, on, "open")).out.split("\n");
  view.wt = { url: pr.url, ...parseCounts(wt, counts) };
  // A worktree is a space of its own, nested under its repo in the sidebar (as the app's worktree
  // mod does). Go to the space already there, else start one in the worktree.
  const inside = p => p === wt || p?.startsWith(`${wt}/`);
  const open = spaces().find(
    s =>
      (s.machine ?? null) === on &&
      (inside(s.folder) || panes().some(p => s.tabs.some(t => t.id === p.tab) && inside(p.cwd))),
  );
  if (open) {
    run("space.select", { id: open.id });
    if (agent) run("tab.new", { space: open.id, folder: wt, name: agent.name, argv: agent.run });
  } else run("space.new", { folder: wt, machine: on ?? "", ...(agent ? { argv: agent.run } : {}) });
  return `${open ? "Switched to the worktree space" : "Opened the worktree in a new space"}${agent ? ` with ${agent.name}` : ""}: ${wt.replace(/^.*\/\.herdr\/worktrees\//, "")} (${note})`;
}

const merge = async (pr, method, on) =>
  check(await exec("gh", ["pr", "merge", pr.url, `--${method}`], { on }), "merge").then(() => {
    pr.state = "MERGED";
    return `Merged (${method})`;
  });
const approve = async (pr, on) =>
  check(await exec("gh", ["pr", "review", pr.url, "--approve"], { on }), "approve").then(() => "Approved");

function button(view, id, label, t, act, { confirm = false, enabled = true } = {}) {
  const asking = view.confirm === id;
  return div()
    .id(`prs-${id}`)
    .px(8)
    .h(24)
    .flex()
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(asking ? t.ansi3 : t.border)
    .text_size(12)
    .text_color(enabled ? (asking ? t.ansi3 : t.muted) : t.dim)
    .when(enabled && !view.busy, el =>
      el
        .cursor_pointer()
        .hover(s => s.bg(t.hover).text_color(t.accent))
        .on_click((_e, cx) => {
          if (confirm && !asking) {
            view.confirm = id;
            cx.timer.after(4000, cx => {
              if (view.confirm === id) view.confirm = null;
              cx.notify();
            });
            return cx.notify();
          }
          view.confirm = null;
          view.busy = label;
          view.msg = null;
          const on = view.openOn;
          cx.spawn(async cx => {
            try {
              view.msg = { ok: true, text: await act(on) };
              if (!["worktree", "sync", "diff", "comments"].includes(id)) view.refresh(cx);
            } catch (err) {
              view.msg = { ok: false, text: String(err.message ?? err) };
            } finally {
              view.busy = null;
              cx.notify();
            }
          });
          cx.notify();
        }),
    )
    .child(view.busy === label || !act ? `${label}…` : asking ? `Confirm ${label.toLowerCase()}?` : label);
}

// ▾ beside Create/Open worktree: the app's popup (mod my-prs-agents) lists installed agents like
// the + menu; the pick comes back through shared state and openPicked runs it.
function agentMenu(view, pr, t) {
  return div()
    .id("prs-agents")
    .h(24)
    .px(6)
    .flex()
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(t.border)
    .text_size(12)
    .text_color(t.muted)
    .cursor_pointer()
    .hover(s => s.bg(t.hover).text_color(t.accent))
    .tooltip("Open the worktree with an agent")
    .on_click(() => {
      if (view.busy) return;
      openOverlay({
        mod: "my-prs-agents",
        kind: "popup",
        width: 220,
        height: 300,
        props: { url: pr.url, on: view.openOn },
      });
    })
    .child("▾");
}

// Called from render: runs a pick made in the popup once, for the open PR.
export function openPicked(view, cx) {
  const pick = shared("my-prs.agentPick");
  if (!pick || pick.at === view.pickAt) return;
  view.pickAt = pick.at;
  const pr = view.open;
  if (!pr || pr.url !== pick.url || Date.now() - pick.at > 10000) return;
  view.busy = "Create worktree";
  const on = view.openOn;
  cx.spawn(async cx => {
    try {
      view.msg = { ok: true, text: await openWorktree(view, pr, on, pick.agent) };
    } catch (err) {
      view.msg = { ok: false, text: String(err.message ?? err) };
    } finally {
      view.busy = null;
      cx.notify();
    }
  });
}

// Open always (reopens a closed space); the ahead/behind status; Sync only when it can fast-forward.
function worktreeButton(view, pr, t) {
  const w = view.wt?.url === pr.url && view.wt.path ? view.wt : null;
  const row = h_flex().gap(6).items_center();
  // Until we know whether it exists, show no Create button to press twice.
  if (view.wt?.url === pr.url && view.wt.checking)
    return row.child(button(view, "worktree", "Checking worktree", t, null, { enabled: false }));
  row.child(button(view, "worktree", w ? "Open worktree" : "Create worktree", t, on => openWorktree(view, pr, on)));
  row.child(agentMenu(view, pr, t));
  if (!w) return row;
  const parts = [];
  if (w.ahead) parts.push([`↑${w.ahead}`, t.ansi4]);
  if (w.behind) parts.push([`↓${w.behind}`, t.ansi3]);
  if (w.dirty) parts.push([`●${w.dirty}`, t.ansi1]);
  if (!parts.length) parts.push(["✓ in sync", t.ansi2]);
  for (const [text, color] of parts) row.child(div().text_size(11).text_color(color).child(text));
  // Only a clean, behind-only worktree can fast-forward; diverged or dirty needs you.
  if (w.behind && !w.ahead && !w.dirty)
    row.child(button(view, "sync", `Sync ↓${w.behind}`, t, on => syncWorktree(view, pr, on)));
  else if (w.behind)
    row.child(
      div()
        .text_size(11)
        .text_color(t.dim)
        .child(w.ahead ? "diverged" : "commit or stash first"),
    );
  return row;
}

function checksLabel(view, pr) {
  const c = view.checks?.url === pr.url ? view.checks : null;
  const failed = c?.list ? failedCount(c.list) : 0;
  return failed ? `Actions ✗${failed}` : "Actions";
}

// View tabs (what the body shows) apart from actions (what changes the PR or disk).
function tabs(view, pr, t) {
  const diffOn = view.diff?.url === pr.url && view.diff.show;
  const c = view.comments?.url === pr.url ? view.comments : null;
  const current = diffOn ? "diff" : view.showChecks ? "checks" : view.showComments ? "comments" : "desc";
  const tab = (id, label, onClick) =>
    div()
      .id(`prs-tab-${id}`)
      .px(10)
      .h(26)
      .flex()
      .items_center()
      .cursor_pointer()
      .border_b(2)
      .border_color(current === id ? t.accent : t.background)
      .text_color(current === id ? t.foreground : t.muted)
      .hover(s => s.text_color(t.accent))
      .on_click((_e, cx) => {
        onClick(cx);
        cx.notify();
      })
      .child(label);
  return h_flex()
    .gap(2)
    .text_size(12)
    .child(
      tab("desc", "Description", () => {
        view.showComments = view.showChecks = false;
        if (view.diff) view.diff.show = false;
      }),
    )
    .child(
      tab("diff", view.diff?.url === pr.url && view.diff.loading ? "Diff…" : "Diff", cx => {
        view.showComments = view.showChecks = false;
        if (view.diff?.url === pr.url) view.diff.show = true;
        else {
          const on = view.openOn;
          cx.spawn(async cx => {
            try {
              await toggleDiff(view, pr, on);
            } catch (err) {
              view.msg = { ok: false, text: String(err.message ?? err) };
            }
            cx.notify();
          });
        }
      }),
    )
    .child(
      tab("comments", `Comments${c?.timeline ? ` ${c.timeline.length}` : ""}`, () => {
        view.showComments = true;
        view.showChecks = false;
        if (view.diff) view.diff.show = false;
      }),
    )
    .child(
      tab("checks", checksLabel(view, pr), cx => {
        view.showChecks = true;
        view.showComments = false;
        if (view.diff) view.diff.show = false;
        // Fetched each time the tab is opened, so a running job's result shows on the next visit.
        const on = view.openOn;
        cx.spawn(async cx => {
          let c;
          try {
            c = { list: await loadChecks(pr, on) };
          } catch (err) {
            c = { error: String(err.message ?? err) };
          }
          if (view.open?.url === pr.url) view.checks = { url: pr.url, ...c };
          cx.notify();
        });
      }),
    );
}

function note(t, text, color) {
  return div()
    .text_size(11)
    .text_color(color ?? t.dim)
    .child(text);
}

export function actions(view, pr, t) {
  const open = pr.state === "OPEN";
  const mergeable = open && !pr.isDraft && pr.mergeable === "MERGEABLE";
  const act = h_flex().flex_wrap().gap(6).items_center();
  if (open) {
    for (const [flag, method, label] of METHODS)
      if (pr.repository[flag])
        act.child(button(view, method, label, t, on => merge(pr, method, on), { confirm: true, enabled: mergeable }));
    if (!pr.viewerDidAuthor) act.child(button(view, "approve", "Approve", t, on => approve(pr, on), { confirm: true }));
    if (!mergeable)
      act.child(
        note(t, pr.isDraft ? "draft" : pr.mergeable === "UNKNOWN" ? "checking mergeability…" : "has conflicts"),
      );
  }
  act.child(div().flex_1()).child(worktreeButton(view, pr, t));
  return v_flex()
    .gap(8)
    .pt(4)
    .child(act)
    .when(Boolean(view.msg), e => e.child(note(t, view.msg.text, view.msg.ok ? t.ansi2 : t.ansi1)))
    .children([agentsSection(view, pr, t)].filter(Boolean))
    .child(tabs(view, pr, t));
}
