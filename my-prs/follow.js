// Follow focus: the focused pane's branch -> its open PR, with as few GitHub calls as possible.
// The branch comes from Herdr; the repo from local git; the PR from the panel's lists, else one
// GraphQL lookup (1 point, not the search limit) cached with misses for 5 minutes.
import { spaces, panes, focused, exec } from "herdr";

const TTL = 5 * 60000;
const repos = new Map(); // `${on}|${cwd}` -> "owner/name" | null
const prs = new Map(); // `${on}|${repo}|${branch}` -> { at, pr }

const repoOf = url => url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?\/?$/)?.[1] ?? null;

// Where focus is: machine, folder and branch (branch null when Herdr doesn't know it).
export function focusKey() {
  const f = focused();
  if (!f) return null;
  const pane = f.pane ? panes().find(p => p.pane === f.pane) : null;
  const space = spaces().find(s => s.active);
  const on = f.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
  const cwd = pane?.cwd || f.cwd;
  return cwd ? { on, cwd, branch: pane?.branch ?? null } : null;
}

async function git(args, cwd, on) {
  const r = await exec("git", ["-C", cwd, ...args], { on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : null;
}

// The open PR for the focused branch, or null. `lists` are the panel's lists for this machine.
export async function prForFocus({ on, cwd, branch }, lists, fields) {
  branch ??= await git(["branch", "--show-current"], cwd, on);
  if (!branch) return null;
  const rk = `${on}|${cwd}`;
  if (!repos.has(rk)) repos.set(rk, repoOf((await git(["remote", "get-url", "origin"], cwd, on)) ?? ""));
  const repo = repos.get(rk);
  if (!repo) return null;
  const same = p => p.headRefName === branch && p.repository.nameWithOwner.toLowerCase() === repo.toLowerCase();
  const listed = Object.values(lists ?? {})
    .flat()
    .find(same);
  if (listed) return listed;
  const key = `${on}|${repo}|${branch}`;
  const hit = prs.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.pr;
  const [owner, name] = repo.split("/");
  const query = `query($o: String!, $n: String!, $b: String!) { repository(owner: $o, name: $n) {
    pullRequests(headRefName: $b, states: OPEN, first: 1) { ${fields} } } }`;
  const r = await exec(
    "gh",
    ["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `n=${name}`, "-f", `b=${branch}`],
    { on },
  );
  if (r.code !== 0) return hit?.pr ?? null; // keep the old answer on errors; retried after TTL anyway
  const pr = JSON.parse(r.stdout).data?.repository?.pullRequests.nodes[0] ?? null;
  prs.set(key, { at: Date.now(), pr });
  return pr;
}
