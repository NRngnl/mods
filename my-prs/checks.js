// The PR's CI checks (GitHub Actions jobs and commit statuses), failed first, fetched when the tab opens.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec } from "herdr";

const QUERY = `query($u: URI!) { resource(url: $u) { ... on PullRequest {
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state targetUrl } } } } } } } } } }`;

// [rank, glyph, theme color]: lower rank sorts first, so failures are on top. Colors match the list.
const STATE = {
  FAILURE: [0, "✗", "ansi1"],
  ERROR: [0, "✗", "ansi1"],
  TIMED_OUT: [0, "✗", "ansi1"],
  STARTUP_FAILURE: [0, "✗", "ansi1"],
  ACTION_REQUIRED: [0, "!", "ansi1"],
  CANCELLED: [1, "⊘", "dim"],
  RUNNING: [2, "●", "ansi3"],
  SUCCESS: [3, "✓", "ansi2"],
  NEUTRAL: [3, "✓", "ansi2"],
  SKIPPED: [4, "⤼", "dim"],
  STALE: [4, "⤼", "dim"],
};

export async function loadChecks(pr, on) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `u=${pr.url}`], { on });
  if (r.code !== 0) throw new Error(`checks: ${r.stderr.trim() || "failed"}`);
  const nodes = JSON.parse(r.stdout).data.resource.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return nodes
    .map(n =>
      n.context
        ? {
            name: n.context,
            state: n.state === "PENDING" || n.state === "EXPECTED" ? "RUNNING" : n.state,
            url: n.targetUrl,
          }
        : {
            name: [n.checkSuite?.workflowRun?.workflow.name, n.name].filter(Boolean).join(" / "),
            state: n.status === "COMPLETED" ? n.conclusion : "RUNNING",
            url: n.detailsUrl,
          },
    )
    .sort((a, b) => (STATE[a.state]?.[0] ?? 2) - (STATE[b.state]?.[0] ?? 2) || a.name.localeCompare(b.name));
}

export const failedCount = checks => checks.filter(c => STATE[c.state]?.[0] === 0).length;

function message(text, t) {
  return div().p(12).text_size(12).text_color(t.dim).child(text);
}

// One row per check: colored glyph, then the name; a click opens its log.
export function checksView(c, t) {
  if (!c) return message("Loading checks…", t);
  if (c.error) return message(c.error, t);
  if (!c.list.length) return message("No checks on the latest commit.", t);
  return v_flex()
    .id("prs-checks")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .p(6)
    .children(
      c.list.map(({ name, state, url }, i) => {
        const [, glyph, color] = STATE[state] ?? [2, "●", "ansi3"];
        return h_flex()
          .id(`prs-check-${i}`)
          .h(26)
          .flex_none()
          .px(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .when(Boolean(url), e =>
            e
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => cx.open_url(url)),
          )
          .child(div().w(12).flex_none().text_color(t[color]).child(glyph))
          .child(div().flex_1().min_w(0).truncate().child(name));
      }),
    );
}
