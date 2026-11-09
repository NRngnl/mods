// "Agents" section of a PR: the agents running on its branch now, then every Pi, Claude and Codex
// conversation that ran in its worktree or (on this branch) its main checkout, each reopenable.
// Live agents come from Herdr; conversations from session files on the PR's machine.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, run } from "herdr";
import { loadConversations, OPEN } from "./conversations.js";
import { ago } from "./time.js";

const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
const TOOL = { pi: "Pi", claude: "Claude", codex: "Codex" };
const SHOW = 5; // conversations shown before "Show all"

const machineOf = a => (a.address.includes("/") ? a.address.split("/")[0] : null);
const branchOf = pr => (pr.isCrossRepository ? `pr-${pr.number}` : pr.headRefName);
const within = (p, root) => Boolean(root) && (p === root || p?.startsWith(`${root}/`));

function live(view, pr) {
  const wt = view.wt?.url === pr.url ? view.wt.path : null;
  const byPane = new Map(panes().map(p => [p.pane, p]));
  return agents()
    .filter(a => {
      if (machineOf(a) !== (view.openOn ?? null)) return false;
      const p = byPane.get(a.pane);
      return p?.branch === branchOf(pr) || within(p?.cwd, wt);
    })
    .sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4));
}

// Loads the conversation list once per PR (and again on ↻). Folders: the worktree, plus every
// open pane on this branch (that covers the main checkout when it has the branch out).
export function loadAgentsFor(view, pr, cx, force = false) {
  if (!force && view.convs?.url === pr.url) return;
  const wt = view.wt?.url === pr.url ? view.wt.path : null;
  const panesOnBranch = panes()
    .filter(p => p.branch === branchOf(pr) && p.cwd)
    .map(p => p.cwd);
  const folders = [...new Set([wt, ...panesOnBranch].filter(Boolean))];
  const main = panesOnBranch.find(p => !within(p, wt)) ?? null;
  view.convs = { url: pr.url, loading: true, list: view.convs?.url === pr.url ? view.convs.list : [] };
  if (!folders.length) {
    view.convs = { url: pr.url, list: [] };
    return;
  }
  const on = view.openOn;
  cx.spawn(async cx => {
    let next;
    try {
      next = { url: pr.url, list: await loadConversations(branchOf(pr), main, folders, on) };
    } catch (err) {
      next = { url: pr.url, list: [], error: String(err.message ?? err) };
    }
    if (view.open?.url === pr.url) view.convs = next;
    cx.notify();
  });
}

// The running agent showing this conversation, or null. An agent of the same tool whose pane is in
// the conversation's folder; with several conversations there, the most recently written one is
// the live one (its file is what the agent keeps appending to).
function runningFor(c, list, running) {
  const keys = c.tool === "claude" ? ["claude", "claude-code"] : [c.tool];
  const byPane = new Map(panes().map(p => [p.pane, p]));
  const agentsHere = running.filter(
    a => (keys.includes(a.program?.key) || keys.includes(a.app)) && byPane.get(a.pane)?.cwd === c.cwd,
  );
  if (!agentsHere.length) return null;
  const newest = list.filter(x => x.tool === c.tool && x.cwd === c.cwd).slice(0, agentsHere.length);
  const i = newest.findIndex(x => x.id === c.id);
  return i < 0 ? null : agentsHere[i];
}

// Opens one conversation in its folder: a tab in the space showing that folder, else a new space.
function reopen(view, c) {
  const argv = OPEN[c.tool]?.(c.id);
  if (!argv) return;
  const on = view.openOn ?? null;
  const shows = sp => sp.folder === c.cwd || panes().some(p => sp.tabs.some(t => t.id === p.tab) && p.cwd === c.cwd);
  const space = spaces().find(sp => (sp.machine ?? null) === on && shows(sp));
  if (space) run("tab.new", { space: space.id, folder: c.cwd, name: TOOL[c.tool], argv });
  else run("space.new", { folder: c.cwd, machine: on ?? "", argv });
}

// Herdr's agents-list marks: spinner working, "Needs you" blocked, dot done, ring idle.
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

function programIcon(p, t) {
  if (!p?.icon) return div().w(14).flex_none();
  return p.tint ? svg(p.icon).size(14).flex_none().text_color(t.foreground) : image(p.icon).size(14).flex_none();
}

// The program table's icon for a tool, taken from any agent Herdr knows of that tool.
function toolIcon(tool, t) {
  const key = tool === "claude" ? ["claude", "claude-code"] : [tool];
  const p = agents().find(a => key.includes(a.program?.key) || key.includes(a.app))?.program;
  if (p) return programIcon(p, t);
  return h_flex()
    .size(14)
    .flex_none()
    .rounded(3)
    .bg(t.hover)
    .items_center()
    .justify_center()
    .text_size(9)
    .font_bold()
    .text_color(t.muted)
    .child(TOOL[tool]?.[0] ?? "?");
}

const label = (t, text) =>
  div().px(10).pt(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());

function liveRow(a, t) {
  return h_flex()
    .id(`prs-agent-row-${a.address}`)
    .h(30)
    .flex_none()
    .mx(4)
    .px(6)
    .gap(9)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .when(a.focused, el => el.bg(t.selected))
    .hover(s => s.bg(t.hover))
    .on_click(() => run("agent.focus", { terminal: a.address }))
    .child(programIcon(a.program, t))
    .child(
      div()
        .flex_none()
        .text_color(t.foreground)
        .child(a.program?.name ?? a.app ?? "agent"),
    )
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(a.title))
    .child(status(t, a.status));
}

function convRow(view, c, wt, t, agent) {
  const where = within(c.cwd, wt) ? "worktree" : c.cwd.split("/").pop();
  return (
    h_flex()
      .id(`prs-conv-${c.tool}-${c.id}`)
      .h(34)
      .flex_none()
      .mx(4)
      .px(6)
      .gap(9)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .tooltip(agent ? "Open in a running agent: go to it" : `${OPEN[c.tool](c.id).join(" ")}\nin ${c.cwd}`)
      // Already open: go to that agent instead of starting a second copy of the conversation.
      .on_click(() => (agent ? run("agent.focus", { terminal: agent.address }) : reopen(view, c)))
      .child(toolIcon(c.tool, t))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(
            div()
              .truncate()
              .text_size(12)
              .text_color(t.foreground)
              .child(c.title || "(no message)"),
          )
          .child(
            div()
              .truncate()
              .text_size(10.5)
              .text_color(t.dim)
              .child(`${TOOL[c.tool]} · ${where} · ${ago(c.at)} ago`),
          ),
      )
      .child(
        agent
          ? h_flex()
              .flex_none()
              .gap(5)
              .items_center()
              .child(status(t, agent.status))
              .child(div().text_size(11).text_color(t.ansi2).child("open"))
          : div().flex_none().text_size(11).text_color(t.muted).child("↻"),
      )
  );
}

export function agentsSection(view, pr, t) {
  const running = live(view, pr);
  const convs = view.convs?.url === pr.url ? view.convs : null;
  const all = convs?.list ?? [];
  if (!running.length && !all.length && !convs?.loading) return null;
  const open = !view.agentsFolded;
  const wt = view.wt?.url === pr.url ? view.wt.path : null;
  const shown = view.convsAll ? all : all.slice(0, SHOW);
  const busy = running.filter(a => a.status === "working").length;
  const blocked = running.some(a => a.status === "blocked");
  return v_flex()
    .rounded(10)
    .border_1()
    .border_color(t.border)
    .bg(t.raised ?? t.background)
    .overflow_hidden()
    .child(
      h_flex()
        .id("prs-agents-head")
        .h(32)
        .px(10)
        .gap(8)
        .items_center()
        .cursor_pointer()
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
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Agents"))
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(`${running.length} running · ${all.length}${convs?.loading ? "…" : ""} conversations`),
        )
        .child(div().flex_1())
        .when(blocked, e => e.child(status(t, "blocked")))
        .when(busy > 0, e => e.child(status(t, "working")))
        .child(
          div()
            .id("prs-convs-reload")
            .px(4)
            .rounded(4)
            .text_size(11)
            .text_color(t.dim)
            .hover(s => s.bg(t.hover).text_color(t.accent))
            .tooltip("Look for conversations again")
            .on_click((_e, cx) => {
              cx.stop_propagation();
              loadAgentsFor(view, pr, cx, true);
              cx.notify();
            })
            .child("↻"),
        ),
    )
    .when(open, e =>
      e
        .border_t(0)
        .when(running.length > 0, e => e.child(label(t, "Running")).children(running.map(a => liveRow(a, t))))
        .child(label(t, "Conversations"))
        // Its own scroll area, at most ~6 rows tall: a long list never pushes the tabs off screen.
        .child(
          v_flex()
            .id("prs-convs-list")
            .flex_none()
            .h(Math.min(view.convsAll ? 220 : 9999, shown.length * 34))
            .overflow_y_scrollbar()
            .children(shown.map(c => convRow(view, c, wt, t, runningFor(c, all, running)))),
        )
        .when(!all.length, e =>
          e.child(
            div()
              .px(10)
              .pb(8)
              .text_size(11.5)
              .text_color(t.dim)
              .child(convs?.error ?? (convs?.loading ? "Looking for conversations…" : "None in this PR's folders")),
          ),
        )
        .when(all.length > SHOW, e =>
          e.child(
            div()
              .id("prs-convs-more")
              .mx(10)
              .mb(8)
              .mt(2)
              .text_size(11)
              .text_color(t.accent)
              .cursor_pointer()
              .on_click((_e, cx) => {
                view.convsAll = !view.convsAll;
                cx.notify();
              })
              .child(view.convsAll ? "Show fewer" : `Show all ${all.length}`),
          ),
        )
        .child(div().h(4)),
    );
}
