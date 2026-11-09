# mods

Personal mods for the [Herdr app](https://github.com/herdrdev/herdr-app) (herdr-app with herdr-core).
Each folder is one mod. Copy it to `~/.config/herdr-app/mods/<name>/` on the machine that runs the app.

## Mods

- [`my-prs`](my-prs/README.md): your PRs, review requests and reviewed PRs with CI, review state,
  diff, comments, merge, approve and worktrees, per machine and GitHub account.
- [`my-spaces`](my-spaces/README.md): Herdr's spaces sidebar with Arc/Dia-style groups: each repo and
  its worktrees as one colored card, fold, pin, and ✕ to remove a worktree.
- [`my-files`](my-files/README.md): Herdr's file browser with upload and download for spaces on
  another machine.

## Install

On the machine that runs the Herdr app:

```sh
git clone https://github.com/NRngnl/mods.git ~/src/herdr-mods
mkdir -p ~/.config/herdr-app/mods
cp -R ~/src/herdr-mods/my-prs ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-prs
```

Use the same steps for `my-files`. To update, `git pull` in the clone and copy the folder again.

Then add the mod to a layout, for example as a tab next to Files in
`~/.config/herdr-app/layouts/<yours>.json` (clone a shipped layout first; shipped ones are replaced
on start), and restart the app. Herdr writes `gpui-kit.d.ts`, `herdr.d.ts` and `jsconfig.json` into
each mod folder on start; they are git-ignored.

## License

Apache-2.0 (see `LICENSE`), the same as Herdr. `my-files` and `my-spaces` are modified from Herdr's `files` and `spaces` mods, and
`my-prs/diff.js` copies its diff rows from Herdr's `changes` mod; both come from
[herdr-app](https://github.com/herdrdev/herdr-app) under Apache-2.0, and those files say so at the top.

## Development

```sh
npm install
scripts/install-hooks.sh   # pre-commit: gitleaks on staged changes, then Biome
npx biome check
```

Before every commit and push, scan for PII and secrets (see `AGENTS.md`).
