#!/bin/sh
# Installs hc-status.sh as Claude Code hooks in ~/.claude/settings.json (backup kept beside it).
# Safe to run again: it replaces only its own entries and leaves other hooks alone.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.claude/hooks/hc-status.sh"
mkdir -p "$HOME/.claude/hooks"
cp "$here/hc-status.sh" "$dest" && chmod +x "$dest"
settings="$HOME/.claude/settings.json"
[ -f "$settings" ] || echo '{}' >"$settings"
cp "$settings" "$settings.bak-hc-status"
python3 - "$settings" "$dest" <<'PY'
import json, sys
path, script = sys.argv[1], sys.argv[2]
s = json.load(open(path))
hooks = s.setdefault("hooks", {})
want = {
    "SessionStart": [(None, "idle")],
    "UserPromptSubmit": [(None, "working")],
    "PreToolUse": [(None, "working")],
    "Notification": [("permission_prompt", "blocked"), ("idle_prompt", "idle")],
    "Stop": [(None, "done")],
}
for event, entries in hooks.items():  # drop our old entries, keep everyone else's
    for m in entries:
        m["hooks"] = [h for h in m.get("hooks", []) if "hc-status.sh" not in h.get("command", "")]
    hooks[event] = [m for m in entries if m.get("hooks")]
for event, rules in want.items():
    for matcher, state in rules:
        entry = {"hooks": [{"type": "command", "command": f"sh '{script}' {state}", "timeout": 5}]}
        if matcher:
            entry["matcher"] = matcher
        hooks.setdefault(event, []).append(entry)
json.dump(s, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
echo "installed: $dest (settings backup: $settings.bak-hc-status). Restart Claude Code."
