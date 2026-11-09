// Every Pi, Claude and Codex conversation that ran in a PR's folders, read from their session
// files on the PR's machine (no GitHub calls). One shell + awk pass prints a TSV line per file.
import { exec } from "herdr";

// Arguments: branch, the main checkout, then every folder to match (worktree and main checkout).
// Prints tool, id, mtime (epoch s), cwd, branch (Claude only), first user text per session file.
// Files match by the cwd recorded inside them; only the first 300 KB of each is read.
const SCRIPT = String.raw`
b="$1"; main="$2"; shift
inside() { for d in "$@"; do [ "$cwd" = "$d" ] && return 0; done; return 1; }
emit() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$tool" "$id" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$cwd" "$br" "$t"; }
json() { grep -m1 -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4; }
tool=pi
for f in $(ls -t "$HOME"/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -400); do
  cwd=$(head -n1 "$f" | json cwd); inside "$@" || continue
  id=$(head -n1 "$f" | json id); br=""
  t=$(head -c 300000 "$f" | grep -m1 -o '"role":"user","content":\[{"type":"text","text":"[^"<]*' | sed 's/.*"text":"//' | cut -c1-160)
  emit
done
tool=claude
for f in $(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -400); do
  cwd=$(head -c 300000 "$f" | json cwd); inside "$@" || continue
  br=$(head -c 300000 "$f" | json gitBranch)
  # In the main checkout, keep only conversations on this branch (Claude records it).
  [ "$cwd" = "$main" ] && [ -n "$br" ] && [ "$br" != "$b" ] && continue
  id=$(basename "$f" .jsonl)
  t=$(head -c 300000 "$f" | grep -m1 -o '"role":"user","content":"[^"<]*' | sed 's/.*"content":"//' | cut -c1-160)
  emit
done
tool=codex
for f in $(find "$HOME"/.codex/sessions -name '*.jsonl' 2>/dev/null | sort | tail -400); do
  cwd=$(head -n1 "$f" | json cwd); inside "$@" || continue
  id=$(head -n1 "$f" | json id); br=""
  t=$(head -c 300000 "$f" | grep -m1 -o '"type":"input_text","text":"[^"<]*' | sed 's/.*"text":"//' | cut -c1-160)
  emit
done
`;

// How each tool reopens one conversation by id.
export const OPEN = {
  pi: id => ["pi", "--session", id],
  claude: id => ["claude", "--resume", id],
  codex: id => ["codex", "resume", id],
};

export async function loadConversations(branch, main, folders, on) {
  const r = await exec("sh", ["-c", SCRIPT, "conversations", branch, main ?? "", ...folders], { on });
  if (r.code !== 0 && !r.stdout) throw new Error(`conversations: ${r.stderr.trim() || "failed"}`);
  const seen = new Set();
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map(l => {
      const [tool, id, at, cwd, br, title] = l.split("\t");
      return { tool, id, at: Number(at) * 1000, cwd, branch: br, title: (title || "").replace(/\\n/g, " ").trim() };
    })
    .filter(c => c.id && !seen.has(`${c.tool}|${c.id}`) && seen.add(`${c.tool}|${c.id}`))
    .sort((a, b) => b.at - a.at)
    .slice(0, 50);
}
