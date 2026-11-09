// The PR's commits as a graph, newest first: one lane for the branch, a side branch drawn into each
// merge commit (base merged in). One GraphQL request when the tab opens; no local checkout needed.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec } from "herdr";
import { ago, localTime } from "./time.js";
import { commitDiff, diffView } from "./diff.js";

const QUERY = `query($u: URI!) { resource(url: $u) { ... on PullRequest {
  baseRefName headRefName
  commits(last: 100) { totalCount nodes { commit {
    oid abbreviatedOid messageHeadline committedDate url
    parents(first: 2) { totalCount }
    author { name user { login } }
    statusCheckRollup { state } } } } } } }`;

const CI = {
  SUCCESS: ["✓", "ansi2"],
  FAILURE: ["✗", "ansi1"],
  ERROR: ["✗", "ansi1"],
  PENDING: ["●", "ansi3"],
  EXPECTED: ["●", "ansi3"],
};

export async function loadCommits(pr, on) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `u=${pr.url}`], { on });
  if (r.code !== 0) throw new Error(`commits: ${r.stderr.trim() || "failed"}`);
  const p = JSON.parse(r.stdout).data.resource;
  return {
    base: p.baseRefName,
    head: p.headRefName,
    total: p.commits.totalCount,
    list: p.commits.nodes.map(n => n.commit).reverse(),
  };
}

const ROW = 40;

// The graph column for one commit: a vertical line through it, a dot (ring for a merge), and for a
// merge a short line in from the right, where the base branch joins.
function lane(c, i, n, t) {
  const merge = c.parents.totalCount > 1;
  const line = color => div().absolute().left(9).w(2).bg(color);
  return div()
    .relative()
    .w(30)
    .h(ROW)
    .flex_none()
    .when(i > 0, e =>
      e.child(
        line(t.accent)
          .top(0)
          .h(ROW / 2),
      ),
    )
    .when(i < n - 1, e =>
      e.child(
        line(t.accent)
          .top(ROW / 2)
          .h(ROW / 2),
      ),
    )
    .when(merge, e =>
      e
        .child(
          div()
            .absolute()
            .left(10)
            .top(ROW / 2 - 1)
            .w(14)
            .h(2)
            .bg(t.dim),
        )
        .child(
          div()
            .absolute()
            .left(22)
            .top(ROW / 2)
            .w(2)
            .h(ROW / 2)
            .bg(t.dim),
        ),
    )
    .child(
      div()
        .absolute()
        .left(5)
        .top(ROW / 2 - 5)
        .size(10)
        .rounded(5)
        .border(2)
        .border_color(t.accent)
        .bg(merge ? t.background : t.accent),
    );
}

// One commit like GitHub's commit page: message on top, then its files and diff.
function commitPage(view, pr, state, t) {
  const c = state.picked;
  const d = state.detail;
  const title = c.messageHeadline;
  const body = (d?.message ?? "").split("\n").slice(1).join("\n").trim();
  const button = (id, label, onClick) =>
    div()
      .id(id)
      .px(6)
      .h(20)
      .flex_none()
      .flex()
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(t.border)
      .cursor_pointer()
      .text_size(11)
      .text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.accent))
      .on_click(onClick)
      .child(label);
  return v_flex()
    .flex_1()
    .min_h(0)
    .child(
      v_flex()
        .flex_none()
        .px(12)
        .py(8)
        .gap(4)
        .border_b(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(
              button("prs-commit-back", "← Commits", (_e, cx) => {
                state.picked = state.detail = null;
                cx.notify();
              }),
            )
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
            .child(button("prs-commit-web", "Open ↗", (_e, cx) => cx.open_url(c.url))),
        )
        .child(
          h_flex()
            .gap(10)
            .text_size(11)
            .text_color(t.dim)
            .child(div().font_family("monospace").child(c.abbreviatedOid))
            .child(div().child(c.author?.user?.login ?? c.author?.name ?? ""))
            .child(div().child(localTime(c.committedDate)))
            .when(Boolean(d?.files), e =>
              e
                .child(
                  div()
                    .text_color(t.ansi2)
                    .child(`+${d.files.reduce((n, f) => n + f.add, 0)}`),
                )
                .child(
                  div()
                    .text_color(t.ansi1)
                    .child(`−${d.files.reduce((n, f) => n + f.del, 0)}`),
                )
                .child(div().child(`${d.files.length} files`)),
            ),
        )
        .when(Boolean(body), e =>
          e.child(
            div()
              .id("prs-commit-body")
              .max_h(120)
              .overflow_y_scrollbar()
              .pt(4)
              .text_size(12)
              .text_color(t.muted)
              .child(body),
          ),
        ),
    )
    .child(
      d?.error
        ? div().p(12).text_size(12).text_color(t.ansi1).child(d.error)
        : d?.files
          ? diffView(d, t)
          : div().p(12).text_size(12).text_color(t.dim).child("Loading commit…"),
    );
}

// Opens a commit in the panel (fetched once per click).
function pick(view, state, pr, c, cx) {
  state.picked = c;
  state.detail = null;
  const on = view.openOn;
  cx.spawn(async cx => {
    let d;
    try {
      d = await commitDiff(pr, c.oid, on);
    } catch (err) {
      d = { error: String(err.message ?? err) };
    }
    if (state.picked?.oid === c.oid) state.detail = d;
    cx.notify();
  });
  cx.notify();
}

export function commitsView(view, pr, state, t) {
  const msg = text => div().p(12).text_size(12).text_color(t.dim).child(text);
  if (!state) return msg("Loading commits…");
  if (state.error) return msg(state.error);
  if (state.picked) return commitPage(view, pr, state, t);
  const n = state.list.length;
  return v_flex()
    .flex_1()
    .min_h(0)
    .child(
      h_flex()
        .flex_none()
        .px(12)
        .py(6)
        .gap(6)
        .text_size(11)
        .text_color(t.dim)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_color(t.accent).child(state.head))
        .child("→")
        .child(div().text_color(t.muted).child(state.base))
        .child(div().flex_1())
        .child(`${state.total} commit${state.total === 1 ? "" : "s"}${state.total > n ? `, newest ${n}` : ""}`),
    )
    .child(
      v_flex()
        .id("prs-commits")
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .px(8)
        .py(4)
        .children(
          state.list.map((c, i) => {
            const [glyph, color] = CI[c.statusCheckRollup?.state] ?? ["", "dim"];
            const merge = c.parents.totalCount > 1;
            return h_flex()
              .id(`prs-commit-${c.oid}`)
              .h(ROW)
              .flex_none()
              .gap(6)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => pick(view, state, pr, c, cx))
              .child(lane(c, i, n, t))
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .child(
                    div()
                      .truncate()
                      .text_size(12.5)
                      .text_color(merge ? t.muted : t.foreground)
                      .child(c.messageHeadline),
                  )
                  .child(
                    h_flex()
                      .gap(8)
                      .text_size(11)
                      .text_color(t.dim)
                      .child(div().font_family("monospace").child(c.abbreviatedOid))
                      .child(
                        div()
                          .truncate()
                          .child(c.author?.user?.login ?? c.author?.name ?? ""),
                      )
                      .child(div().flex_none().child(ago(c.committedDate))),
                  ),
              )
              .child(div().w(14).flex_none().text_color(t[color]).child(glyph));
          }),
        ),
    );
}
