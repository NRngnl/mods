#!/bin/sh
# Reports Claude Code's state to herdr-core (OSC 7501, the Program Status Protocol), so hc and the
# Herdr app list it as an agent like Pi. Called from Claude Code hooks with the state to report.
# Outside any terminal it does nothing; it never fails the hook.
cat >/dev/null 2>&1 # hooks pass JSON on stdin; not needed
state="${1:-}"
case "$state" in idle | working | blocked | done) ;; *) exit 0 ;; esac
# Claude runs hooks without a controlling terminal, so /dev/tty can fail: then write to the
# terminal Claude itself runs on, found through the parent processes.
msg=$(printf '\033]7501;state=%s:app=claude-code\033\\' "$state")
if ! { printf %s "$msg" >/dev/tty; } 2>/dev/null; then
  pid=$$
  while [ "${pid:-1}" -gt 1 ]; do
    t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$t" in ""|"?"|"??") ;; *) { printf %s "$msg" >"/dev/${t#/dev/}"; } 2>/dev/null && break ;; esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
fi
exit 0
