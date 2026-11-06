// Toasts for what changed between two refreshes of the same machine's lists.
// Nothing on the first load (no previous lists), so startup does not flood.
import { notify } from "herdr";

const ci = p => p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
const talk = p =>
  [p.comments.nodes[0]?.createdAt, p.reviews.nodes[0]?.submittedAt].filter(Boolean).sort().pop() ?? null;
const commit = p => p.commits.nodes[0]?.commit.committedDate ?? null;
const name = p => `${p.repository.nameWithOwner}#${p.number}`;

// One line per change, most important first.
function changes(before, after) {
  const was = new Map(
    Object.values(before)
      .flat()
      .map(p => [p.url, p]),
  );
  const out = [];
  for (const p of after.review)
    if (!before.review.some(b => b.url === p.url)) out.push(["warning", "Review requested", p]);
  for (const p of Object.values(after).flat()) {
    const b = was.get(p.url);
    if (!b) continue;
    if (ci(b) !== ci(p) && ci(p) === "FAILURE") out.push(["error", "CI failed", p]);
    else if (ci(b) !== ci(p) && ci(p) === "SUCCESS") out.push(["success", "CI passed", p]);
    if (b.reviewDecision !== p.reviewDecision && p.reviewDecision === "APPROVED") out.push(["success", "Approved", p]);
    if (b.reviewDecision !== p.reviewDecision && p.reviewDecision === "CHANGES_REQUESTED")
      out.push(["warning", "Changes requested", p]);
    if (talk(p) && talk(p) !== talk(b)) out.push(["info", "New comment", p]);
    if (!p.viewerDidAuthor && commit(p) && commit(p) !== commit(b)) out.push(["info", "New commits", p]);
  }
  return out;
}

// Seen this refresh, keyed by PR and kind, so the same change is not posted twice.
const posted = new Set();

// Returns the URLs that changed (for the list's marks). Posts at most one toast per refresh,
// and only when `toast` is on, so updates never pile up.
export function notifyChanges(before, after, on, toast) {
  if (!before || !after) return [];
  const list = changes(before, after).filter(([, kind, p]) => {
    const key = `${p.url}|${kind}|${ci(p)}|${p.reviewDecision}|${talk(p)}|${commit(p)}`;
    if (posted.has(key)) return false;
    posted.add(key);
    return true;
  });
  if (!list.length) return [];
  if (toast) {
    const where = on ? ` on ${on}` : "";
    const [level, kind, p] = list[0];
    const lines = list.slice(0, 5).map(([, k, p]) => `${k}: ${name(p)}`);
    if (list.length > 5) lines.push(`and ${list.length - 5} more`);
    notify(
      list.length === 1
        ? { level, timeout: 6000, title: `${kind}${where}`, body: `${name(p)} ${p.title}` }
        : { timeout: 6000, title: `${list.length} PR updates${where}`, body: lines.join("\n") },
    );
  }
  return list.map(([, , p]) => p.url);
}
