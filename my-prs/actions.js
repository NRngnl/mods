// Detail-view actions: merge, approve, and open the PR's branch as a worktree tab in its project space.
// Everything runs on the PR list's machine, with that machine's gh and git.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, exec, run } from "herdr";
import { toggleDiff } from "./diff.js";

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
printf '%s\\n%s' "$wt" "$note"`;

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
export const findWorktree = (pr, on) =>
  worktree(pr, on, "find").then(
    ({ out }) => {
      if (!out) return null;
      const [path, counts] = out.split("\n");
      const [ahead, behind, dirty] = counts.split(" ").map(Number);
      return { path, ahead, behind, dirty };
    },
    () => null,
  );

async function syncWorktree(view, pr, on) {
  const { out } = await worktree(pr, on, "sync");
  view.wt = { url: pr.url, ...(await findWorktree(pr, on)) };
  return `Synced: ${out.split("\n")[1]}`;
}

async function openWorktree(view, pr, on) {
  const { out } = await worktree(pr, on, "open");
  const [wt, note] = out.split("\n");
  view.wt = { url: pr.url, ...(await findWorktree(pr, on)) };
  // A worktree is a space of its own, nested under its repo in the sidebar (as the app's worktree
  // mod does). Go to the space already there, else start one in the worktree.
  const inside = p => p === wt || p?.startsWith(`${wt}/`);
  const open = spaces().find(
    s =>
      (s.machine ?? null) === on &&
      (inside(s.folder) || panes().some(p => s.tabs.some(t => t.id === p.tab) && inside(p.cwd))),
  );
  if (open) run("space.select", { id: open.id });
  else run("space.new", { folder: wt, machine: on ?? "" });
  return `${open ? "Switched to the worktree space" : "Opened the worktree in a new space"}: ${wt.replace(/^.*\/\.herdr\/worktrees\//, "")} (${note})`;
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

function commentsButton(view, pr, t) {
  const c = view.comments?.url === pr.url ? view.comments : null;
  const label = view.showComments ? "Description" : `Comments${c?.timeline ? ` (${c.timeline.length})` : ""}`;
  return button(view, "comments", label, t, () => {
    view.showComments = !view.showComments;
    if (view.diff) view.diff.show = false;
    return "";
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

export function actions(view, pr, t) {
  const row = h_flex().flex_wrap().gap(6).items_center();
  if (pr.state !== "OPEN") {
    row.child(
      button(view, "diff", view.diff?.url === pr.url && view.diff.show ? "Description" : "Diff", t, on =>
        toggleDiff(view, pr, on),
      ),
    );
    row.child(commentsButton(view, pr, t));
    row.child(worktreeButton(view, pr, t));
    if (view.msg)
      row.child(
        div()
          .text_size(11)
          .text_color(view.msg.ok ? t.ansi2 : t.ansi1)
          .child(view.msg.text),
      );
    return row;
  }
  const mergeable = !pr.isDraft && pr.mergeable === "MERGEABLE";
  for (const [flag, method, label] of METHODS)
    if (pr.repository[flag])
      row.child(button(view, method, label, t, on => merge(pr, method, on), { confirm: true, enabled: mergeable }));
  if (!pr.viewerDidAuthor) row.child(button(view, "approve", "Approve", t, on => approve(pr, on), { confirm: true }));
  row.child(
    button(view, "diff", view.diff?.url === pr.url && view.diff.show ? "Description" : "Diff", t, on =>
      toggleDiff(view, pr, on),
    ),
  );
  row.child(commentsButton(view, pr, t));
  row.child(worktreeButton(view, pr, t));
  if (!mergeable)
    row.child(
      div()
        .text_size(11)
        .text_color(t.dim)
        .child(pr.isDraft ? "draft" : pr.mergeable === "UNKNOWN" ? "checking mergeability…" : "has conflicts"),
    );
  if (view.msg)
    row.child(
      div()
        .text_size(11)
        .text_color(view.msg.ok ? t.ansi2 : t.ansi1)
        .child(view.msg.text),
    );
  return row;
}
