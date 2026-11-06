// Open PRs I wrote, PRs waiting for my review, and ones I already reviewed, with CI state.
// gh runs on the focused space's machine, so each machine uses its own gh login.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, focused, exec, theme, window } from "herdr";
import { actions, findWorktree } from "./actions.js";
import { diffView } from "./diff.js";

function machine() {
  const space = spaces().find(s => s.active),
    f = focused();
  return f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
}

const FIELDS = `nodes { ... on PullRequest { number title url state isDraft reviewDecision body additions deletions changedFiles
  headRefName isCrossRepository mergeable viewerDidAuthor
  repository { nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
const QUERY = `{
  rateLimit { remaining resetAt }
  mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 30) { ${FIELDS} }
  review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 30) { ${FIELDS} }
  done: search(query: "is:pr is:open reviewed-by:@me -author:@me -review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 15) { ${FIELDS} }
}`;
const SECTIONS = [
  ["mine", "My PRs"],
  ["review", "Awaiting my review"],
  ["done", "Reviewed by me (still open)"],
];
const CI = {
  SUCCESS: ["✓", "ansi2"],
  FAILURE: ["✗", "ansi1"],
  ERROR: ["✗", "ansi1"],
  PENDING: ["●", "ansi3"],
  EXPECTED: ["●", "ansi3"],
};
const DECISION = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "needs review" };

async function load(on) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "gh failed (installed and logged in on this machine?)");
  const data = JSON.parse(r.stdout).data;
  const lists = Object.fromEntries(
    SECTIONS.map(([k]) => [k, data[k].nodes.filter(n => n.number && n.state === "OPEN")]),
  );
  return { lists, rate: data.rateLimit };
}

const MINUTE = 60000;
// When the next automatic refresh may run, from the last result (manual ↻ ignores it).
function nextAllowed(rate, failures, err) {
  const now = Date.now();
  if (rate && rate.remaining < 300) return new Date(rate.resetAt).getTime() + 5000;
  if (err && /rate limit|secondary|abuse|403|429/i.test(err)) return now + 10 * MINUTE;
  if (failures) return now + Math.min(15, 2 ** failures) * MINUTE;
  return now + MINUTE;
}

export default class Prs extends View {
  init(_props, cx) {
    this.lists = null;
    this.failures = 0;
    this.next = 0;
    this.refresh(cx);
    // Tick often but only fetch when due, and only while the window is in front.
    cx.timer.every(15000, cx => {
      if (window()?.active && Date.now() >= this.next) this.refresh(cx);
    });
  }

  refresh(cx) {
    const on = machine();
    if (this.loading && on === this.on) return; // never two requests at once
    // A new machine means a different gh account: drop the old lists instead of showing them as current.
    if (on !== this.on) {
      this.lists = null;
      this.open = null;
      this.error = null;
      this.updated = null;
    }
    this.on = on;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const { lists, rate } = await load(on);
        if (this.on !== on) return;
        this.lists = lists;
        this.rate = rate;
        this.failures = 0;
        this.next = nextAllowed(rate, 0);
        if (this.open)
          this.open =
            Object.values(lists)
              .flat()
              .find(p => p.url === this.open.url) ?? this.open;
        this.error = null;
        this.updated = new Date();
      } catch (err) {
        if (this.on === on) {
          this.error = String(err.message ?? err);
          this.failures++;
          this.next = nextAllowed(null, this.failures, this.error);
        }
      } finally {
        if (this.on === on) this.loading = false;
        cx.notify();
      }
    });
  }

  row(pr, t) {
    const [icon, color] = CI[pr.commits.nodes[0]?.commit.statusCheckRollup?.state] ?? ["–", "dim"];
    const note = [pr.isDraft && "draft", DECISION[pr.reviewDecision]].filter(Boolean).join(" · ");
    return h_flex()
      .id(`pr-${pr.url}`)
      .h(40)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.open = pr;
        this.msg = this.confirm = null;
        this.wt = null;
        const on = this.on;
        cx.spawn(async cx => {
          const path = await findWorktree(pr, on);
          if (this.open?.url === pr.url) this.wt = { url: pr.url, path };
          cx.notify();
        });
        cx.notify();
      })
      .child(div().w(12).flex_none().text_color(t[color]).child(icon))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().child(pr.title))
          .child(
            div()
              .truncate()
              .text_size(11)
              .text_color(t.dim)
              .child(`${pr.repository.nameWithOwner}#${pr.number}${note ? ` · ${note}` : ""}`),
          ),
      )
      .child(this.loc(pr, t))
      .child(
        div()
          .id(`copy-${pr.url}`)
          .h(24)
          .px(8)
          .flex_none()
          .flex()
          .items_center()
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .text_size(12)
          .text_color(this.copied === pr.url ? t.ansi2 : t.muted)
          .hover(s => s.bg(t.hover).text_color(t.accent))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            cx.write_to_clipboard(pr.url);
            this.copied = pr.url;
            cx.timer.after(1500, cx => {
              if (this.copied === pr.url) this.copied = null;
              cx.notify();
            });
            cx.notify();
          })
          .child(this.copied === pr.url ? "✓ Copied" : "Copy"),
      );
  }

  loc(pr, t) {
    return h_flex()
      .flex_none()
      .gap(4)
      .text_size(11)
      .child(div().text_color(t.ansi2).child(`+${pr.additions}`))
      .child(div().text_color(t.ansi1).child(`-${pr.deletions}`));
  }

  detail(pr, t) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .flex_none()
          .p(12)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child(pr.title))
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .text_size(11)
              .text_color(t.dim)
              .child(div().flex_1().min_w(0).truncate().child(`${pr.repository.nameWithOwner}#${pr.number}`))
              .child(this.loc(pr, t))
              .child(div().child(`${pr.changedFiles} files`))
              .child(
                div()
                  .id("prs-browser")
                  .px(8)
                  .h(22)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover(s => s.bg(t.hover).text_color(t.accent))
                  .on_click((_e, cx) => cx.open_url(pr.url))
                  .child("Open ↗"),
              ),
          )
          .child(actions(this, pr, t)),
      )
      .child(
        this.diff?.url === pr.url && this.diff.show
          ? diffView(this.diff, t)
          : TextView.markdown(`prs-body-${pr.url}`, pr.body?.trim() || "_No description._")
              .selectable()
              .scrollable()
              .flex_1()
              .min_h(0)
              .p(12)
              .on_link_click((url, cx) => cx.open_url(url)),
      );
  }

  render(cx) {
    // Also refresh when the app window comes back to the front, if the data is over 15 s old.
    const active = window()?.active;
    if (machine() !== this.on) this.refresh(cx);
    else if (
      active &&
      !this.active &&
      !this.failures &&
      !(this.rate?.remaining < 300) &&
      Date.now() - (this.updated ?? 0) > 15000
    )
      this.refresh(cx);
    this.active = active;
    const t = theme();
    const body = [];
    if (this.error) body.push(div().p(8).text_size(12).text_color(t.ansi1).child(this.error));
    else if (!this.lists)
      body.push(
        div()
          .p(8)
          .text_size(12)
          .text_color(t.dim)
          .child(`Loading PRs from ${this.on ?? "local"}…`),
      );
    else
      for (const [k, label] of SECTIONS) {
        const list = this.lists[k];
        body.push(
          div().px(8).pt(10).pb(4).text_size(11).font_semibold().text_color(t.muted).child(`${label} (${list.length})`),
        );
        if (!list.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("None"));
        for (const pr of list) body.push(this.row(pr, t));
      }
    return v_flex()
      .id("prs")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(this.open), el =>
            el.child(
              div()
                .id("prs-back")
                .w(20)
                .cursor_pointer()
                .text_color(t.muted)
                .on_click((_e, cx) => {
                  this.open = null;
                  cx.notify();
                })
                .child("←"),
            ),
          )
          .child(div().font_semibold().child("PRs"))
          .child(
            div()
              .flex_1()
              .truncate()
              .text_right()
              .text_size(12)
              .text_color(t.dim)
              .child(
                `${this.on ?? "local"} · ${
                  this.loading
                    ? this.lists
                      ? "refreshing…"
                      : "switching…"
                    : this.updated
                      ? `updated ${this.updated.toTimeString().slice(0, 5)}`
                      : ""
                }${
                  !this.loading && this.next - Date.now() > 2 * MINUTE
                    ? ` · paused to ${new Date(this.next).toTimeString().slice(0, 5)}`
                    : ""
                }`,
              ),
          )
          .child(
            div()
              .id("prs-refresh")
              .px(4)
              .cursor_pointer()
              .text_color(t.muted)
              .hover(s => s.text_color(t.accent))
              .on_click((_e, cx) => this.refresh(cx))
              .child("↻"),
          ),
      )
      .child(
        this.open
          ? this.detail(this.open, t)
          : v_flex().id("prs-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(body),
      );
  }
}
