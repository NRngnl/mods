// diffRows and the row drawing are copied from Herdr's `changes` mod (herdr-app, Apache-2.0).
// In-panel PR diff, drawn like Herdr's Changes mod: a file list, then a virtual list of numbered rows.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, settings } from "herdr";
import { threadRows } from "./comments.js";

const MAX_LINES = 1500,
  MAX_COLS = 4000;

// Numbers each diff line once, so a frame only draws the rows on screen (from Changes).
function diffRows(lines) {
  let old = 0,
    next = 0;
  return lines.map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line };
    }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") {
      old++;
      return { kind, number: next++, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });
}

// Splits `gh pr diff` output into files with their hunks and +/- counts.
function parse(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const all = chunk.replace(/\n$/, "").split("\n"),
      first = all.findIndex(l => l.startsWith("@@"));
    const plus = all.find(l => l.startsWith("+++ "))?.slice(4),
      minus = all.find(l => l.startsWith("--- "))?.slice(4);
    const path =
      (plus && plus !== "/dev/null" ? plus.replace(/^b\//, "") : minus?.replace(/^a\//, "")) ??
      all[0].split(" b/").pop();
    const status = plus === "/dev/null" ? "D" : minus === "/dev/null" ? "A" : "M";
    const lines =
      first < 0 ? [/^Binary files/m.test(chunk) ? "Binary file changed" : "No text diff"] : all.slice(first);
    let add = 0,
      del = 0;
    for (const l of lines) {
      if (l[0] === "+") add++;
      else if (l[0] === "-") del++;
    }
    files.push({ path, status, add, del, lines });
  }
  return files;
}

function select(state, path) {
  state.open = path;
  const lines = (state.files.find(f => f.path === path)?.lines ?? [])
    .slice(0, MAX_LINES)
    .map(l => (l.length > MAX_COLS ? `${l.slice(0, MAX_COLS)}… (line truncated)` : l));
  const rows = diffRows(lines);
  // Inline threads go under the line they point at; outdated ones (no line) at the top.
  const threads = (state.threads ?? []).filter(th => th.path === path);
  const at = new Map();
  for (const th of threads) {
    const i =
      th.line == null
        ? -1
        : rows.findIndex(r => r.number === th.line && (th.diffSide === "LEFT" ? r.kind !== "+" : r.kind !== "-"));
    at.set(i, [...(at.get(i) ?? []), ...threadRows(th)]);
  }
  state.rows = [...(at.get(-1) ?? []), ...rows.flatMap((r, i) => [r, ...(at.get(i) ?? [])])];
  state.heads = state.rows.flatMap((r, i) => (r.head ? [i] : []));
  state.width = Math.max(300, ...lines.map(l => l.length * 7 + 50));
}

// GitHub refuses whole diffs over its size limit; the files API still returns each file's patch
// (up to 3,000 files; a single huge file comes back without one).
async function perFile(pr, on) {
  const [, repo, n] = pr.url.match(/github\.com\/(.+?\/.+?)\/pull\/(\d+)/);
  const jq = ".[] | {path: .filename, status, add: .additions, del: .deletions, patch}";
  const r = await exec("gh", ["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`, "--jq", jq], { on });
  if (r.code !== 0) throw new Error(`diff: ${r.stderr.trim() || "failed"}`);
  const STATUS = { added: "A", removed: "D" };
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .map(f => ({
      path: f.path,
      status: STATUS[f.status] ?? "M",
      add: f.add,
      del: f.del,
      lines: f.patch ? f.patch.split("\n") : ["Diff too large to show for this file"],
    }));
}

// Toggles the diff for `pr`; fetches it (gh on that machine) only the first time it is shown.
export async function toggleDiff(view, pr, on) {
  const threads = view.comments?.url === pr.url ? view.comments.threads : [];
  if (view.diff?.url === pr.url) {
    view.diff.show = !view.diff.show;
    view.showComments = view.showChecks = view.showCommits = false;
    return "";
  }
  view.showComments = view.showChecks = view.showCommits = false;
  view.diff = { url: pr.url, show: true, files: [], rows: [], width: 300, loading: true, threads };
  view.diff.scroll = VirtualListScrollHandle.new();
  const r = await exec("gh", ["pr", "diff", pr.url, "--color=never"], { on });
  const state = view.diff?.url === pr.url ? view.diff : null;
  if (!state) return "";
  state.loading = false;
  if (r.code === 0) state.files = parse(r.stdout);
  else if (/too_large|406/.test(r.stderr)) state.files = await perFile(pr, on);
  else throw new Error(`diff: ${r.stderr.trim() || "failed"}`);
  for (const f of state.files) f.threads = threads.filter(th => th.path === f.path).length;
  if (state.files.length) select(state, state.files[0].path);
  return "";
}

function row({ kind, number, text, head, author, resolved }, t) {
  if (kind === "c")
    return div()
      .w_full()
      .h(20)
      .flex_none()
      .pl(40)
      .truncate()
      .bg(`${t.ansi4}14`)
      .border_l(2)
      .border_color(resolved ? t.border : t.ansi4)
      .text_color(head ? (resolved ? t.dim : t.ansi3) : author ? t.accent : resolved ? t.dim : t.foreground)
      .when(Boolean(author), e => e.font_semibold())
      .child(text);
  if (kind === "@")
    return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  return h_flex()
    .w_full()
    .h(20)
    .flex_none()
    .gap(10)
    .when(kind === "+", e => e.bg(`${t.ansi2}18`))
    .when(kind === "-", e => e.bg(`${t.ansi1}18`))
    .child(
      div()
        .w(30)
        .flex_none()
        .text_right()
        .text_color(t.dim)
        .child(number === undefined ? "" : String(number)),
    )
    .child(div().flex_1().min_w(0).truncate().child(text));
}

// Every thread across files, in file order: [{ path, row }].
function allThreads(state) {
  const out = [];
  for (const f of state.files) {
    if (!f.threads) continue;
    if (f.path === state.open) out.push(...state.heads.map(row => ({ path: f.path, row })));
    else for (let i = 0; i < f.threads; i++) out.push({ path: f.path, row: null, n: i });
  }
  return out;
}

// Moves to the previous (-1) or next (+1) inline thread, switching files when needed.
function jump(state, step) {
  const list = allThreads(state);
  if (!list.length) return;
  const here = list.findIndex(x => x.path === state.open && x.row === state.heads[state.at ?? -1]);
  let i = here < 0 ? (step > 0 ? list.findIndex(x => x.path === state.open) : -1) : here + step;
  if (here < 0 && step > 0 && i < 0) i = 0;
  i = (i + list.length) % list.length;
  const target = list[i];
  if (target.path !== state.open) {
    select(state, target.path);
    state.at = step > 0 ? 0 : state.heads.length - 1;
  } else state.at = state.heads.indexOf(target.row);
  state.scroll.scroll_to_item(state.heads[state.at], "center");
}

function jumpBar(state, t) {
  const total = state.files.reduce((n, f) => n + (f.threads || 0), 0);
  if (!total) return div();
  const before = state.files
    .slice(
      0,
      state.files.findIndex(f => f.path === state.open),
    )
    .reduce((n, f) => n + (f.threads || 0), 0);
  const pos = state.at == null ? "–" : String(before + state.at + 1);
  const btn = (id, label, step) =>
    div()
      .id(id)
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
      .on_click((_e, cx) => {
        jump(state, step);
        cx.notify();
      })
      .child(label);
  return h_flex()
    .flex_none()
    .px(10)
    .py(4)
    .gap(6)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .text_size(11)
    .child(div().text_color(t.ansi4).child(`✉ ${pos}/${total} comments`))
    .child(div().flex_1())
    .child(btn("prs-prev-comment", "↑ Prev", -1))
    .child(btn("prs-next-comment", "↓ Next", 1));
}

export function diffView(state, t) {
  const color = { A: t.ansi2, D: t.ansi1, M: t.blocked };
  return v_flex()
    .flex_1()
    .min_h(0)
    .child(
      v_flex()
        .id("prs-diff-files")
        .flex_none()
        .h(Math.min(200, Math.max(44, state.files.length * 28 + 12)))
        .overflow_y_scrollbar()
        .p(6)
        .border_b(1)
        .border_color(t.border)
        .children(
          state.files.map(f => {
            const parts = f.path.split("/"),
              name = parts.pop();
            return h_flex()
              .id(`prs-diff-${f.path}`)
              .h(28)
              .flex_none()
              .px(8)
              .gap(8)
              .items_center()
              .rounded(7)
              .cursor_pointer()
              .when(state.open === f.path, e => e.bg(t.selected))
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => {
                select(state, f.path);
                state.at = null;
                cx.notify();
              })
              .child(div().w(14).text_size(11).text_color(color[f.status]).child(f.status))
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .child(
                    div()
                      .text_color(t.dim)
                      .truncate()
                      .child(parts.length ? `${parts.join("/")}/` : ""),
                  )
                  .child(div().max_w(260).min_w(0).truncate().child(name)),
              )
              .when(Boolean(f.threads), e => e.child(div().text_size(11).text_color(t.ansi4).child(`✉${f.threads}`)))
              .when(f.add > 0, e => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
              .when(f.del > 0, e => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
          }),
        )
        .when(!state.files.length, e =>
          e.child(
            div()
              .p(8)
              .text_color(t.dim)
              .child(state.loading ? "Loading diff…" : "No changes"),
          ),
        ),
    )
    .child(jumpBar(state, t))
    .child(
      div()
        .flex_1()
        .min_h(0)
        .relative()
        .font_family(settings().font_family ?? "JetBrains Mono")
        .text_size(11)
        .child(
          div()
            .id("prs-diff-x")
            .size_full()
            .overflow_x_scrollbar()
            .child(
              div()
                .w_full()
                .min_w(state.width)
                .h_full()
                .child(
                  v_virtual_list(
                    "prs-diff",
                    state.rows.length,
                    20,
                    i => String(i),
                    range => state.rows.slice(range.start, range.end).map(r => row(r, t)),
                  )
                    .track_scroll(state.scroll)
                    .size_full(),
                ),
            ),
        )
        .child(Scrollbar.vertical("prs-diff").viewport_from_layout().absolute().inset_0()),
    );
}
