// Open PRs I wrote, PRs waiting for my review, and ones I already reviewed, with CI state.
// gh runs on the focused space's machine, so each machine uses its own gh login.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, focused, exec, theme, window, shared, setShared } from "herdr";
import { actions, findWorktree } from "./actions.js";
import { diffView } from "./diff.js";
import { localTime, ago } from "./time.js";
import { loadComments, commentsMarkdown } from "./comments.js";
import { checksView } from "./checks.js";
import { focusKey, prForFocus } from "./follow.js";
import { notifyChanges } from "./notify.js";

function machine() {
  const space = spaces().find(s => s.active),
    f = focused();
  return f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
}

const FIELDS = `nodes { ... on PullRequest { number title url state isDraft createdAt reviewDecision body additions deletions changedFiles
  headRefName isCrossRepository mergeable viewerDidAuthor
  repository { nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed } comments(last: 1) { nodes { createdAt } } reviews(last: 1) { nodes { submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } } } }`;
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
const DECISION = { APPROVED: "✔ approved", CHANGES_REQUESTED: "✎ changes", REVIEW_REQUIRED: "◌ review" };

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

// Opened, last commit and last comment or review; the latter two only when they exist.
function times(pr, fmt) {
  const commit = pr.commits.nodes[0]?.commit.committedDate;
  const talk = [pr.comments.nodes[0]?.createdAt, pr.reviews.nodes[0]?.submittedAt].filter(Boolean).sort().pop();
  // ⊕ opened, ⊙ last commit, ✉ last comment or review
  return [`⊕ ${fmt(pr.createdAt)}`, commit && `⊙ ${fmt(commit)}`, talk && `✉ ${fmt(talk)}`].filter(Boolean).join("   ");
}

// A header checkbox stored in the app's persisted shared settings; on by default.
function toggle(id, key, label, t) {
  const on = shared(key) !== false;
  return div()
    .id(id)
    .px(4)
    .cursor_pointer()
    .text_size(12)
    .text_color(on ? t.accent : t.dim)
    .hover(s => s.text_color(t.accent))
    .on_click((_e, cx) => {
      setShared(key, !on);
      cx.notify();
    })
    .child(`${on ? "☑" : "☐"} ${label}`);
}

export default class Prs extends View {
  init(_props, cx) {
    this.lists = null;
    this.cache = new Map();
    this.unseen = new Set(); // PR URLs changed since you last opened them
    this.failures = 0;
    this.next = 0;
    this.refresh(cx);
    // Tick often but only fetch when due, and only while the window is in front.
    cx.timer.every(15000, cx => {
      if (window()?.active && Date.now() >= this.next) this.refresh(cx, false);
    });
  }

  // Each machine (its own gh account) keeps its lists and refresh schedule; switching swaps them.
  swap(on) {
    const KEYS = ["lists", "rate", "updated", "failures", "next", "error"];
    if (this.on !== undefined) this.cache.set(this.on, Object.fromEntries(KEYS.map(k => [k, this[k]])));
    const saved = this.cache.get(on) ?? { lists: null, failures: 0, next: 0 };
    for (const k of KEYS) this[k] = saved[k] ?? null;
    this.failures ??= 0;
    this.next ??= 0;
    this.on = on;
    this.loading = false;
  }

  refresh(cx, force = true) {
    const on = machine();
    if (on !== this.on) {
      this.swap(on);
      force = false;
    }
    if (this.loading) return; // never two requests at once
    if (!force && this.lists && Date.now() < this.next) return; // cached and fresh enough; render already shows the swapped-in lists
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const { lists, rate } = await load(on);
        if (this.on !== on) {
          // Switched away while loading: keep the result for when you come back.
          const saved = this.cache.get(on) ?? {};
          this.mark(notifyChanges(saved.lists, lists, on, shared("my-prs.notify") !== false));
          this.cache.set(on, {
            ...saved,
            lists,
            rate,
            updated: new Date(),
            failures: 0,
            error: null,
            next: nextAllowed(rate, 0),
          });
          return;
        }
        this.mark(notifyChanges(this.lists, lists, on, shared("my-prs.notify") !== false));
        this.lists = lists;
        this.rate = rate;
        this.failures = 0;
        this.next = nextAllowed(rate, 0);
        if (this.open && this.openOn === on)
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

  // Check runs and commit statuses grouped as passed / failed / skipped / remaining.
  ciCounts(pr, t) {
    const ctx = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    if (!ctx) return div();
    const GROUP = {
      SUCCESS: "ok",
      NEUTRAL: "ok",
      COMPLETED: "ok",
      FAILURE: "fail",
      ERROR: "fail",
      TIMED_OUT: "fail",
      STARTUP_FAILURE: "fail",
      CANCELLED: "fail",
      ACTION_REQUIRED: "fail",
      SKIPPED: "skip",
      STALE: "skip",
    };
    const n = { ok: 0, fail: 0, skip: 0, left: 0 };
    for (const { state, count } of [...ctx.checkRunCountsByState, ...ctx.statusContextCountsByState])
      n[GROUP[state] ?? "left"] += count;
    const total = n.ok + n.fail + n.skip + n.left;
    if (!total) return div();
    const parts = [
      [`${n.ok + n.fail}/${total}`, t.muted],
      n.fail && [`✗${n.fail}`, t.ansi1],
      n.skip && [`⤼${n.skip}`, t.dim],
      n.left && [`●${n.left}`, t.ansi3],
    ].filter(Boolean);
    return h_flex()
      .flex_none()
      .gap(4)
      .text_size(11)
      .children(parts.map(([text, color]) => div().text_color(color).child(text)));
  }

  mark(urls) {
    for (const u of urls) this.unseen.add(u);
  }

  openPr(pr, cx, on = this.on) {
    this.unseen.delete(pr.url);
    this.open = pr;
    this.openOn = on; // its actions keep using this machine's gh after a space switch
    this.msg = this.confirm = null;
    this.wt = { url: pr.url, checking: true };
    this.comments = null;
    this.showComments = this.showChecks = false;
    this.checks = null;
    cx.spawn(async cx => {
      let c;
      try {
        c = await loadComments(pr, on);
      } catch (err) {
        c = { error: String(err.message ?? err), threads: [] };
      }
      if (this.open?.url === pr.url) this.comments = { url: pr.url, ...c };
      cx.notify();
    });
    cx.spawn(async cx => {
      const found = await findWorktree(pr, on);
      if (this.open?.url === pr.url) this.wt = { url: pr.url, ...found };
      cx.notify();
    });
  }

  // When focus lands on a branch with an open PR, show it. Runs from render; no notify there.
  follow(cx) {
    const f = focusKey();
    const key = f && `${f.on}|${f.cwd}|${f.branch}`;
    if (key === this.followKey) return;
    this.followKey = key;
    if (!f) return;
    cx.spawn(async cx => {
      try {
        const pr = await prForFocus(f, f.on === this.on ? this.lists : null, FIELDS);
        if (this.followKey !== key || !pr || this.open?.url === pr.url) return;
        this.openPr(pr, cx, f.on);
        cx.notify();
      } catch {
        // following is a convenience; a failed lookup leaves the panel as it is
      }
    });
  }

  row(pr, t) {
    const [icon, color] = CI[pr.commits.nodes[0]?.commit.statusCheckRollup?.state] ?? ["–", "dim"];
    const note = [pr.isDraft && "◇ draft", DECISION[pr.reviewDecision]].filter(Boolean).join(" · ");
    return h_flex()
      .id(`pr-${pr.url}`)
      .flex_none()
      .px(8)
      .py(5)
      .gap(8)
      .items_start()
      .border_b(1)
      .border_color(t.border)
      .rounded(7)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.openPr(pr, cx);
        cx.notify();
      })
      .child(div().w(12).flex_none().pt(1).text_color(t[color]).child(icon))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          // 1: the whole title, wrapped, with Copy at the end of the first line
          .child(
            h_flex()
              .gap(8)
              .items_start()
              .when(this.unseen.has(pr.url), e => e.child(div().flex_none().text_color(t.accent).child("●")))
              .child(div().flex_1().min_w(0).truncate().child(pr.title))
              .child(
                div()
                  .id(`copy-${pr.url}`)
                  .h(20)
                  .px(6)
                  .flex_none()
                  .flex()
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .text_size(11)
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
              ),
          )
          // 2: where it is and what state it is in
          .child(
            h_flex()
              .gap(10)
              .items_center()
              .text_size(11)
              .child(div().min_w(0).truncate().text_color(t.muted).child(`${pr.repository.nameWithOwner}#${pr.number}`))
              .when(Boolean(note), e => e.child(div().flex_none().text_color(t.dim).child(note)))
              .child(div().flex_1())
              .child(this.ciCounts(pr, t))
              .child(this.loc(pr, t)),
          )
          // 3: when things happened
          .child(div().text_size(11).text_color(t.dim).child(times(pr, ago))),
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
          // repo and state on one line, numbers on the next; each item stays whole
          .child(
            h_flex()
              .flex_wrap()
              .gap_x(10)
              .items_center()
              .text_size(11)
              .text_color(t.muted)
              .child(div().child(`${pr.repository.nameWithOwner}#${pr.number}`))
              .when(Boolean(pr.isDraft), e => e.child(div().text_color(t.dim).child("◇ draft")))
              .when(Boolean(DECISION[pr.reviewDecision]), e =>
                e.child(div().text_color(t.dim).child(DECISION[pr.reviewDecision])),
              )
              .child(div().flex_1())
              .child(
                div()
                  .id("prs-browser")
                  .px(6)
                  .h(20)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.accent))
                  .on_click((_e, cx) => cx.open_url(pr.url))
                  .child("Open ↗"),
              ),
          )
          .child(
            h_flex()
              .flex_wrap()
              .gap_x(12)
              .items_center()
              .text_size(11)
              .text_color(t.dim)
              .children(
                times(pr, localTime)
                  .split("   ")
                  .map(x => div().child(x)),
              )
              .child(div().flex_1())
              .child(this.ciCounts(pr, t))
              .child(this.loc(pr, t))
              .child(div().child(`${pr.changedFiles} files`)),
          )
          .child(actions(this, pr, t)),
      )
      .child(
        this.diff?.url === pr.url && this.diff.show
          ? diffView(this.diff, t)
          : this.showChecks
            ? checksView(this.checks?.url === pr.url ? this.checks : null, t)
            : TextView.markdown(
                `prs-${this.showComments ? "comments" : "body"}-${pr.url}`,
                this.showComments
                  ? commentsMarkdown(this.comments?.url === pr.url ? this.comments : null)
                  : pr.body?.trim() || "_No description._",
              )
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
    // On unless turned off; the choice is persisted by the app.
    if (shared("my-prs.follow") !== false) this.follow(cx);
    else this.followKey = null;
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
          .child(toggle("prs-notify", "my-prs.notify", "Notify", t))
          .child(
            div()
              .id("prs-follow")
              .px(4)
              .cursor_pointer()
              .text_size(12)
              .text_color(shared("my-prs.follow") !== false ? t.accent : t.dim)
              .hover(s => s.text_color(t.accent))
              .on_click((_e, cx) => {
                setShared("my-prs.follow", shared("my-prs.follow") === false);
                cx.notify();
              })
              .child(`${shared("my-prs.follow") !== false ? "☑" : "☐"} Follow`),
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
