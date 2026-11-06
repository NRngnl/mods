// In-panel PR diff, drawn like Herdr's Changes mod: a file list, then a virtual list of numbered rows.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, settings } from "herdr";

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
  state.rows = diffRows(lines);
  state.width = Math.max(300, ...lines.map(l => l.length * 7 + 50));
}

// Toggles the diff for `pr`; fetches it (gh on that machine) only the first time it is shown.
export async function toggleDiff(view, pr, on) {
  if (view.diff?.url === pr.url) {
    view.diff.show = !view.diff.show;
    return "";
  }
  view.diff = { url: pr.url, show: true, files: [], rows: [], width: 300, loading: true };
  const r = await exec("gh", ["pr", "diff", pr.url, "--color=never"], { on });
  const state = view.diff?.url === pr.url ? view.diff : null;
  if (!state) return "";
  state.loading = false;
  if (r.code !== 0) throw new Error(`diff: ${r.stderr.trim() || "failed (too large?)"}`);
  state.files = parse(r.stdout);
  if (state.files.length) select(state, state.files[0].path);
  return "";
}

function row({ kind, number, text }, t) {
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
                  ).size_full(),
                ),
            ),
        )
        .child(Scrollbar.vertical("prs-diff").viewport_from_layout().absolute().inset_0()),
    );
}
