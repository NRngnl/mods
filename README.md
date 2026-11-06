# mods

Personal mods for the [Herdr app](https://github.com/herdrdev/herdr-app) (herdr-app with herdr-core).
Each folder is one mod. Copy it to `~/.config/herdr-app/mods/<name>/` on the machine that runs the app.

## my-files

A clone of Herdr's `files` mod: a lazy file browser for the focused pane's folder, with read-only
previews. On a remote machine it can upload (drop files, or ⬆) and download files.

## my-prs

Pull requests from `gh`, beside your terminals.

- **Lists:** my open PRs, PRs awaiting my review, and PRs I reviewed that are still open. Each row
  shows CI (✓ ✗ ●, plus finished/total, failed, skipped and running checks), review state,
  `+/−` lines and when it was opened (⊕), last committed (⊙) and last commented (✉).
- **Per machine:** `gh` runs on the focused space's machine, so each machine uses its own GitHub
  login. Each machine keeps its own cached lists.
- **Detail:** click a row for the description, an in-panel diff with inline review threads (↑/↓ jump
  between them) and the conversation newest first. Actions: merge (the repo's allowed methods),
  approve, and a worktree for the PR's branch under `~/.herdr/worktrees/<repo>/<branch>`, opened as its
  own space. The worktree shows ahead/behind/dirty, and Sync appears when it can fast-forward.
- **Follow:** when on, focusing a pane opens the PR for that pane's branch.
- **Notify:** when on, one toast per refresh for new review requests, CI results, approvals,
  comments and commits. Changed rows get a ● until you open them.
- **Rate limits:** one GraphQL search per refresh, at most once a minute and only while the window
  is in front. It backs off when GitHub's limit runs low or a request fails. ↻ refreshes now.

Needs `gh` (logged in) and `git` on each machine whose spaces you use it from.

## Install

```sh
rsync -av --exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json \
  <host>:<path-to-this-repo>/my-prs/ ~/.config/herdr-app/mods/my-prs/
herdr-app check ~/.config/herdr-app/mods/my-prs
```

Then add the mod to a layout (for example as a tab next to Files in `layouts/<yours>.json`) and restart
the app. Herdr writes `gpui-kit.d.ts`, `herdr.d.ts` and `jsconfig.json` into each mod folder on start;
they are git-ignored.

## Development

```sh
npm install
scripts/install-hooks.sh   # pre-commit: gitleaks on staged changes, then Biome
npx biome check
```

Before every commit and push, scan for PII and secrets (see `AGENTS.md`).
