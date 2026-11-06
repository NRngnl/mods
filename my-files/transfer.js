// Part of my-files, modified from Herdr's `files` mod (herdr-app, Apache-2.0).
// Upload/download files and folders between this Mac and a remote space's machine with scp -r.
import { exec, hc, home, notify } from "herdr";

const targets = new Map();
async function target(machine) {
  if (!targets.has(machine)) {
    const r = await hc(["machine", "ls", "--json"]);
    for (const m of JSON.parse(r.stdout).machines) targets.set(m.name, m.target);
  }
  const t = targets.get(machine);
  if (!t) throw new Error(`No ssh target for ${machine}`);
  return t;
}

const name = p => p.replace(/\/+$/, "").split("/").pop();

// Names (of `names`) that already exist in `dir`, on `machine` (null: this Mac).
async function existing(dir, names, machine) {
  const r = await exec(
    "sh",
    ["-c", 'd=$1; shift; for n; do [ -e "$d/$n" ] && printf "%s\\n" "$n"; done; true', "x", dir, ...names],
    { on: machine },
  );
  return r.stdout.split("\n").filter(Boolean);
}

// Native macOS dialog; true only when the user picks Overwrite.
async function confirmOverwrite(names, where) {
  const list = names.slice(0, 10).join("\n") + (names.length > 10 ? `\n… and ${names.length - 10} more` : "");
  const msg = `Already in ${where}:\n\n${list}\n\nOverwrite?`;
  const r = await exec("osascript", [
    "-e",
    "on run argv",
    "-e",
    'display dialog (item 1 of argv) buttons {"Cancel", "Overwrite"} default button "Cancel" cancel button "Cancel" with icon caution with title "Herdr Files"',
    "-e",
    "end run",
    msg,
  ]);
  return r.code === 0 && r.stdout.includes("Overwrite");
}

// shortcut: no progress bar; a folder overwrite merges into the existing folder (scp -r).
async function scp(args, label) {
  notify({ title: label, body: "Copying…", timeout: 3000 });
  const r = await exec("scp", ["-r", "-p", "-o", "BatchMode=yes", ...args]);
  if (r.code !== 0) notify({ title: `${label} failed`, body: r.stderr.trim().slice(0, 300), level: "error" });
  else notify({ title: `${label} done`, body: args.slice(0, -1).map(name).join(", "), timeout: 4000 });
  return r.code === 0;
}

// Native picker: asks Files… or Folder…, then returns the chosen POSIX paths ([] on cancel).
const PICK = `on run argv
activate
set b to button returned of (display dialog ("Upload to " & item 1 of argv) buttons {"Cancel", "Folder…", "Files…"} default button "Files…" cancel button "Cancel" with title "Herdr Files")
if b is "Files…" then
set xs to choose file with prompt "Files to upload" with multiple selections allowed
else
set xs to choose folder with prompt "Folders to upload" with multiple selections allowed
end if
set out to ""
repeat with x in xs
set out to out & POSIX path of x & linefeed
end repeat
return out
end run`;

export async function pickAndUpload(machine, remoteDir) {
  const r = await exec("osascript", ["-e", PICK, `${machine}:${remoteDir}`]);
  const paths = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  return paths.length ? upload(machine, paths, remoteDir) : false;
}

export async function upload(machine, localPaths, remoteDir) {
  const t = await target(machine);
  localPaths = localPaths.map(p => p.replace(/(.)\/+$/, "$1"));
  const clash = await existing(remoteDir, localPaths.map(name), machine);
  if (clash.length && !(await confirmOverwrite(clash, `${machine}:${remoteDir}`))) return false;
  return scp([...localPaths, `${t}:${remoteDir}/`], `Upload to ${machine}`);
}

export async function download(machine, remotePath) {
  const t = await target(machine),
    dl = `${home()}/Downloads`;
  const clash = await existing(dl, [name(remotePath)], null);
  if (clash.length && !(await confirmOverwrite(clash, "~/Downloads"))) return false;
  return scp([`${t}:${remotePath}`, `${home()}/Downloads/`], `Download ${name(remotePath)}`);
}
