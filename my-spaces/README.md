# my-spaces

Herdr's `spaces` sidebar (herdr-app, Apache-2.0) with one addition: a **✕** at the end of every
worktree space's row. It opens Herdr's own **Remove worktree** dialog, the same as the space's
right-click menu, which warns about uncommitted or unpushed work, then closes the space with its
agents and shells and removes the checkout. The branch stays.

## Install

```sh
cp -R my-spaces ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-spaces
```

In your layout, replace `"mod": "spaces"` with `"mod": "my-spaces"`.

Copied from herdr-app at commit b721ded; Herdr's later changes to `spaces` are not picked up.
