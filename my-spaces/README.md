# my-spaces

Herdr's `spaces` sidebar (herdr-app, Apache-2.0) with Arc/Dia-style grouping added. Everything
the shipped sidebar does still works: machines, colored avatars, worktrees nested under their
repo, ahead/behind, drag to reorder, right-click menu.

```
┃ ▾ ◆ A app                  ← a repo with worktrees is one tinted card
┃      ⑂ feature-x  #78  ↑1   ✕
┃      ⑂ fix-bug         ✕
┃ ▸ ◇ B backend  +3          ← folded: 3 worktrees hidden
  ◇ D docs                   ← spaces without worktrees stay plain
```

## Groups

A repo space and its worktrees are drawn as one card in the repo's avatar color: a light tint,
a bar down the left and rounded ends. The space you're in gets a stronger tint of the same
color.

## Fold

▾ / ▸ before a repo's avatar folds or expands its worktrees. A folded repo shows `+N` for the
hidden ones. The worktree you're in stays visible even when its repo is folded.

## Pin

◇ / ◆ on a space pins it. Pinned spaces (with their worktrees) move to the top of their
machine's list, in their current order.

## PR badge

With [`my-prs`](../my-prs/README.md) installed, a space whose branch has an open PR shows `#N` after
its name, colored by CI (green passed, red failed, yellow running). Click it to open the PR. It reads
what my-prs already fetched, so it adds no GitHub requests; only PRs in my-prs' lists get one.

## Remove a worktree

✕ on a worktree row opens Herdr's own **Remove worktree** dialog, the same as the right-click
menu. It warns about uncommitted or unpushed work, then closes the space with its agents and
shells and removes the checkout. The branch stays.

Folds and pins are saved and survive restarts.

## Install

```sh
cp -R my-spaces ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-spaces
```

In your layout, replace `"mod": "spaces"` with `"mod": "my-spaces"`, then restart the app.

## Limits

- The narrow (icon-only) sidebar has no fold or pin controls.
- Dragging a space above a pinned one is put back by the pin order.
- Copied from herdr-app at commit b721ded; Herdr's later changes to `spaces` are not picked up.
