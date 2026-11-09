// The agents whose pane is on this PR's branch (or inside its worktree), as a foldable section.
// Herdr already reports each pane's branch and folder, so this costs no git or GitHub calls.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, run } from "herdr";

const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };

function related(view, pr) {
  const wt = view.wt?.url === pr.url ? view.wt.path : null;
  const branch = pr.isCrossRepository ? `pr-${pr.number}` : pr.headRefName;
  const byPane = new Map(panes().map(p => [p.pane, p]));
  const machine = a => (a.address.includes("/") ? a.address.split("/")[0] : null);
  return agents()
    .filter(a => {
      if (machine(a) !== (view.openOn ?? null)) return false;
      const p = byPane.get(a.pane);
      return p?.branch === branch || (wt && (p?.cwd === wt || p?.cwd?.startsWith(`${wt}/`)));
    })
    .sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4));
}

// Same marks as Herdr's agents list: spinner working, "Needs you" blocked, dot done, ring idle.
function status(t, s) {
  if (s === "working")
    return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (s === "blocked")
    return div()
      .flex_none()
      .px(6)
      .h(18)
      .rounded(5)
      .bg(`${t.blocked}26`)
      .text_size(10.5)
      .font_semibold()
      .text_color(t.blocked)
      .flex()
      .items_center()
      .child("Needs you");
  if (s === "idle")
    return div()
      .size(7)
      .flex_none()
      .rounded(4)
      .border(1.5)
      .border_color(t.idle ?? t.dim);
  return div()
    .size(7)
    .flex_none()
    .rounded(4)
    .bg(s === "done" ? (t.done ?? t.ansi2) : t.dim);
}

function icon(p, t) {
  if (!p?.icon) return div().w(14).flex_none();
  return p.tint ? svg(p.icon).size(14).flex_none().text_color(t.foreground) : image(p.icon).size(14).flex_none();
}

export function agentsSection(view, pr, t) {
  const list = related(view, pr);
  if (!list.length) return null;
  const open = !view.agentsFolded;
  const busy = list.filter(a => a.status === "working").length,
    blocked = list.filter(a => a.status === "blocked").length;
  return v_flex()
    .rounded(8)
    .border_1()
    .border_color(t.border)
    .overflow_hidden()
    .child(
      h_flex()
        .id("prs-agents-head")
        .h(28)
        .px(10)
        .gap(8)
        .items_center()
        .cursor_pointer()
        .bg(t.raised ?? t.background)
        .hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          view.agentsFolded = open;
          cx.notify();
        })
        .child(
          svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`)
            .size(11)
            .text_color(t.dim),
        )
        .child(
          div().text_size(11.5).font_semibold().text_color(t.muted).child(`Agents on this branch · ${list.length}`),
        )
        .child(div().flex_1())
        .when(blocked > 0, e => e.child(status(t, "blocked")))
        .when(busy > 0, e =>
          e.child(
            h_flex()
              .gap(4)
              .items_center()
              .child(status(t, "working"))
              .child(div().text_size(11).text_color(t.dim).child(String(busy))),
          ),
        ),
    )
    .when(open, e =>
      e.children(
        list.map(a =>
          h_flex()
            .id(`prs-agent-row-${a.address}`)
            .h(30)
            .px(10)
            .gap(9)
            .items_center()
            .border_t(1)
            .border_color(t.border)
            .cursor_pointer()
            .when(a.focused, el => el.bg(t.selected))
            .hover(s => s.bg(t.hover))
            .on_click(() => run("agent.focus", { terminal: a.address }))
            .child(icon(a.program, t))
            .child(
              div()
                .flex_none()
                .text_color(t.foreground)
                .child(a.program?.name ?? a.app ?? "agent"),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.dim)
                .child(`${a.space_name} · ${a.title}`),
            )
            .child(status(t, a.status)),
        ),
      ),
    );
}
