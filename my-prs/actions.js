// Detail-view actions: merge, approve, and open the PR's branch as a worktree tab in its project space.
// Everything runs on the PR list's machine, with that machine's gh and git.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, exec, run } from "herdr";
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
wt=$(git worktree list --porcelain | awk -v r="refs/heads/$b" '/^worktree /{p=substr($0,10)} $0=="branch "r{print p; exit}')
if [ "$5" = find ]; then printf %s "$wt"; exit 0; fi
if [ "$4" = true ]; then git fetch -q origin "pull/$n/head"; else git fetch -q origin "$b"; fi
head=$(git rev-parse FETCH_HEAD)
if [ -z "$wt" ]; then
  [ "$5" = sync ] && { echo "worktree no longer exists" >&2; exit 1; }
  wt="$(dirname "$top")/$(basename "$top")-pr-$n"
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

async function projectSpace(repo, on) {
  for (const s of spaces().filter(s => (s.machine ?? null) === on && s.folder)) {
    const r = await exec("git", ["-C", s.folder, "remote", "get-url", "origin"], { on }).catch(() => null);
    if (r?.code === 0 && repoOf(r.stdout.trim()) === repo.toLowerCase()) return s;
  }
  throw new Error(`No space on ${on ?? "local"} is a checkout of ${repo}`);
}

async function worktree(pr, on, mode) {
  const space = await projectSpace(pr.repository.nameWithOwner, on);
  const branch = pr.isCrossRepository ? `pr-${pr.number}` : pr.headRefName;
  const args = ["-c", WORKTREE, "wt", space.folder, branch, String(pr.number), String(pr.isCrossRepository), mode];
  return { space, out: await check(await exec("sh", args, { on }), "worktree") };
}

// The PR's worktree path on disk, or null. Local git only, no network.
export const findWorktree = (pr, on) =>
  worktree(pr, on, "find").then(
    r => r.out || null,
    () => null,
  );

async function syncWorktree(view, pr, on) {
  const { out } = await worktree(pr, on, "sync");
  return `Synced ${out.split("\n")[0].split("/").pop()}: ${out.split("\n")[1]}`;
}

async function openWorktree(view, pr, on) {
  const { space, out } = await worktree(pr, on, "open");
  const [wt, note] = out.split("\n");
  view.wt = { url: pr.url, path: wt };
  run("space.select", { id: space.id });
  run("tab.new", { space: space.id, folder: wt, name: `#${pr.number}` });
  return `Opened ${wt.split("/").pop()} in ${space.name}, ${note}`;
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
          const on = view.on;
          cx.spawn(async cx => {
            try {
              view.msg = { ok: true, text: await act(on) };
              if (!["worktree", "sync", "diff"].includes(id)) view.refresh(cx);
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
    .child(view.busy === label ? `${label}…` : asking ? `Confirm ${label.toLowerCase()}?` : label);
}

function worktreeButton(view, pr, t) {
  const path = view.wt?.url === pr.url ? view.wt.path : null;
  return path
    ? button(view, "sync", "Sync", t, on => syncWorktree(view, pr, on))
    : button(view, "worktree", "Worktree", t, on => openWorktree(view, pr, on));
}

export function actions(view, pr, t) {
  const row = h_flex().flex_wrap().gap(6).items_center();
  if (pr.state !== "OPEN") {
    row.child(
      button(view, "diff", view.diff?.url === pr.url && view.diff.show ? "Description" : "Diff", t, on =>
        toggleDiff(view, pr, on),
      ),
    );
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
