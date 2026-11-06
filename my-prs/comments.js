// PR conversation and review threads, fetched once when a PR is opened (gh on that machine).
import { exec } from "herdr";
import { localTime } from "./time.js";

const QUERY = `query($u: URI!) { resource(url: $u) { ... on PullRequest {
  comments(last: 50) { nodes { author { login } body createdAt } }
  reviews(last: 30) { nodes { author { login } state body createdAt } }
  reviewThreads(last: 100) { nodes { path line originalLine diffSide isResolved isOutdated
    comments(first: 30) { nodes { author { login } body createdAt } } } } } } }`;

const STATE = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};
const who = c => c.author?.login ?? "ghost";
const when = c => localTime(c.createdAt);

export async function loadComments(pr, on) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `u=${pr.url}`], { on });
  if (r.code !== 0) throw new Error(`comments: ${r.stderr.trim() || "failed"}`);
  const p = JSON.parse(r.stdout).data.resource;
  // Reviews with no text and no verdict worth showing are just containers for inline comments.
  const reviews = p.reviews.nodes.filter(v => v.body.trim() || v.state !== "COMMENTED");
  const timeline = [...p.comments.nodes, ...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { timeline, threads: p.reviewThreads.nodes };
}

// Markdown appended under the description.
export function commentsMarkdown(c) {
  if (!c) return "_Loading comments…_";
  if (c.error) return `_${c.error}_`;
  const parts = c.timeline.map(
    x => `**${who(x)}**${x.state ? ` ${STATE[x.state] ?? x.state}` : ""} · ${when(x)}\n\n${x.body.trim()}`,
  );
  const open = c.threads.filter(t => !t.isResolved).length;
  if (c.threads.length) parts.unshift(`_${c.threads.length} inline threads (${open} unresolved) — see Diff_`);
  return `### Comments (${c.timeline.length}), newest first\n\n${parts.join("\n\n---\n\n") || "_None_"}`;
}

// Diff rows for one thread: a header row, then one row per comment line (rows are fixed height).
export function threadRows(thread) {
  const head = `${thread.isResolved ? "✓ resolved" : "● unresolved"}${thread.isOutdated ? " · outdated" : ""}`;
  const rows = [{ kind: "c", text: head, head: true, resolved: thread.isResolved }];
  for (const c of thread.comments.nodes) {
    rows.push({ kind: "c", text: `${who(c)} · ${when(c)}`, author: true, resolved: thread.isResolved });
    for (const line of c.body.trim().split("\n").slice(0, 40))
      rows.push({ kind: "c", text: `  ${line || " "}`, resolved: thread.isResolved });
  }
  return rows;
}
