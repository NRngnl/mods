# my-prs

GitHub pull requests in a Herdr app panel: the ones you wrote, the ones waiting for you, and the
ones you already reviewed, with CI and review state, so you don't lose track of what you handled.

## The list

Three sections, each the open PRs across all your repos:

- **My PRs**
- **Awaiting my review**: you are a requested reviewer. Submitting a review takes it out.
- **Reviewed by me (still open)**: what you already handled.

Each row:

```
✗  ci: skip unrelated changes, shorten build + test                     [Copy]
   owner/repo#78   ✔ approved                  3/3 ✗1   +91 −17
   ⊕ 1h   ⊙ 50m   ✉ 5m
```

| Mark | Meaning |
|---|---|
| ✓ ✗ ● – | CI passed, failed, running, none |
| `3/3 ✗1 ⤼1 ●2` | checks finished/total, failed, skipped, still running |
| ✔ ✎ ◌ ◇ | approved, changes requested, needs review, draft |
| ⊕ ⊙ ✉ | opened, last commit, last comment or review (ages) |
| ● before the title | changed since you last opened it |

**Copy** copies the PR link to the clipboard of the Mac running the app.

## A PR's detail

Click a row. The header has the repo, review state, exact local times, CI and line counts, and
**Open ↗** for the browser. Then:

- **Merge**: one button per method the repo allows. Needs a second click to confirm.
- **Approve**: on PRs you didn't write, also with a confirm click.
- **Create / Open worktree**: checks out the PR's branch in `~/.herdr/worktrees/<repo>/<branch>`
  (where the app's own worktrees go) and opens it as a space, or goes to it when it's already open.
  An existing worktree on the branch is reused. Next to it: ↑ unpushed, ↓ behind the PR, ● uncommitted
  files, or ✓ in sync. **Sync ↓N** fast-forwards when that is safe; diverged or dirty
  worktrees are left to you.
- **▾** beside the worktree button: pick an installed agent (like the app's + menu) to open the
  worktree with it, in a new space or as a new tab in its open space. Needs the `my-prs-agents` mod
  installed too; it is the popup.
- **Agents**: a foldable section with the agents running on the PR's branch (Herdr's status marks;
  click to go to one) and every Pi, Claude and Codex conversation that ran in the PR's worktree, or
  in a checkout open on its branch, newest first. Click a conversation to reopen exactly that one
  (`pi --session`, `claude --resume`, `codex resume`); one that is already open is marked **open**
  and goes to its agent instead. Read from the agents' session files on the PR's machine.
- Tabs: **Description**, **Diff** (files, hunks and inline review threads; ↑ Prev / ↓ Next jump
  between threads, across files), **Comments** (newest first) and **Actions** (every check on the
  latest commit, failed first, as colored ✗ ● ✓ ⤼; click one to open its log).

## Header switches

- **Follow**: focusing a pane opens the PR for that pane's branch, if it has an open one.
- **Notify**: one toast per refresh for new review requests, CI passing or failing, approvals,
  change requests, comments and new commits on others' PRs.
- **↻**: refresh now.

Both switches are on by default and saved with the app's settings.

## Machines and accounts

`gh` and `git` run on the focused space's machine, so a space on another machine uses that
machine's GitHub login (for example a work account). Each machine keeps its own lists. An open
PR keeps using the machine it came from.

## GitHub rate limits

- The lists are one GraphQL request per refresh (2 points of 5,000/hour), once a minute and only while
  the window is in front.
- It pauses until the reset when fewer than 300 points are left, waits 10 minutes after a
  rate-limit error, and backs off up to 15 minutes after other failures. The header says
  `paused to HH:MM`.
- Comments, diffs, Actions and worktree checks run only when you open them. Follow looks in the lists
  first and caches other branches for 5 minutes.

## Requirements

`gh` (logged in with `gh auth login`) and `git` on every machine you use it from.

## Install

```sh
cp -R my-prs my-prs-agents ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-prs
herdr-app check ~/.config/herdr-app/mods/my-prs-agents
```

Then add `{ "mod": "my-prs" }` to a layout, for example as a tab next to Files (see the repo README).

## Limits

- Up to 30 PRs per section (15 for reviewed).
- Diffs: 1,500 lines per file. Diffs over GitHub's size limit load file by file.
- Comments: the last 50, and 30 per thread. Reading only; reply on GitHub.
- Follow matches by branch name, so fork PRs and renamed branches are not found.
- Marks and cached lists reset when the app restarts.
