# my-files

A file browser for the focused pane's folder, modified from Herdr's shipped `files` mod
(herdr-app, Apache-2.0). It adds file transfer for spaces on another machine.

## What it does

- Lists the focused pane's folder as a lazy tree (folders load when opened). It follows focus: a
  different pane or space shows its own folder.
- Marks files with git changes, and refreshes when files change (and every 10 seconds).
- Click a file for a read-only, syntax-colored preview. ← goes back.
- **..** at the top goes up a folder; ⌂ in the header goes back to the focused pane's folder.
- Right-click a row for **Rename** (never overwrites an existing name), **Copy path**,
  **Copy relative path** (from the git root) and, on folders, **Open here**.
- Limits: 500 entries per folder, 5,000 in total; previews up to 400 KB.

On a space on another machine (`hc machine`), it also transfers files:

- **Upload:** drop files or folders from Finder onto a folder row (or the tree), or click ⬆ on a
  folder (⬆ Upload in the header for the root) to pick them.
- **Download:** ⬇ on a row copies that file or folder to `~/Downloads`.
- It asks before overwriting, and shows the result as a toast.

## Requirements

- macOS for the app: the picker uses `osascript`.
- `scp` on the Mac, and the machine reachable over ssh as `hc machine ls` lists it, with key
  login (`BatchMode=yes`, no password prompt).

## Install

```sh
cp -R my-files ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/my-files
```

Then put `{ "mod": "my-files" }` in a layout where Files was (see the repo README).

## Notes

- Transfers have no progress bar. Uploading a folder that already exists merges into it.
