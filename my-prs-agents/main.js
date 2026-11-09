// Popup for my-prs: pick an agent to open a PR's worktree with. Opened by my-prs as an overlay
// (so it floats above the panel); the choice goes back through shared("my-prs.agentPick").
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, knownAgents, shared, setShared } from "herdr";

export default class Agents extends View {
  init(_props, cx) {
    const { on } = props();
    this.agents = shared("my-prs.agents")?.[on ?? ""] ?? null;
    cx.spawn(async cx => {
      try {
        this.agents = (await knownAgents({ on })).filter(a => a.installed);
        setShared("my-prs.agents", { ...shared("my-prs.agents"), [on ?? ""]: this.agents });
      } catch {
        this.agents ??= [];
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const { url, overlay } = props();
    return v_flex()
      .id("prs-agents")
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .children(
        (this.agents ?? []).map(a =>
          h_flex()
            .id(`prs-agent-${a.key}`)
            .h(31)
            .px(9)
            .gap(10)
            .items_center()
            .flex_none()
            .rounded(7)
            .hover(s => s.bg(t.selected))
            .on_click(() => {
              closeOverlay(overlay);
              setShared("my-prs.agentPick", { url, agent: a, at: Date.now() });
            })
            .child(a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14))
            .child(div().flex_1().child(a.name)),
        ),
      )
      .when(!this.agents, e => e.child(div().px(9).py(6).text_color(t.dim).child("Checking installed agents…")))
      .when(this.agents?.length === 0, e => e.child(div().px(9).py(6).text_color(t.dim).child("No agents found")));
  }
}
