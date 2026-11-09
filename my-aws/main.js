// AWS panel: CodePipeline state and CloudWatch Logs, read-only, through the `aws` CLI on the
// focused machine. Credentials are whatever that CLI resolves (profiles, SSO, env).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, focused, exec, theme, settings, shared, setShared, machines } from "herdr";

function machine() {
  const space = spaces().find(s => s.active),
    f = focused();
  return f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
}

async function aws(on, profile, region, args) {
  const opts = [...(profile ? ["--profile", profile] : []), ...(region ? ["--region", region] : [])];
  const r = await exec("aws", [...args, ...opts, "--output", "json"], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "aws failed (installed and logged in on this machine?)");
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

const STATUS = { Succeeded: ["✓", "ansi2"], Failed: ["✗", "ansi1"], InProgress: ["●", "ansi3"], Stopped: ["■", "ansi1"], Stopping: ["■", "ansi3"], Abandoned: ["–", "dim"], Superseded: ["–", "dim"] };
const ago = ms => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
// Only real region codes (ap-northeast-1) reach the CLI; anything else means the profile default.
const isRegion = v => /^[a-z]{2}(-[a-z]+)+-\d$/.test(v ?? "");
const regionOf = input => (isRegion(input.value().trim()) ? input.value().trim() : "");
// Time-range presets for group/stream logs, like the console's relative ranges.
const RANGES = [["5m", 3e5], ["15m", 9e5], ["1h", 36e5], ["3h", 108e5], ["12h", 432e5], ["1d", 864e5], ["1w", 6048e5]];
const MAX_EVENTS = 2000;
const time = v => (v == null ? 0 : typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

export default class Aws extends View {
  init(_props, cx) {
    const saved = shared("my-aws") ?? {};
    this.profile = saved.profile ?? null;
    this.tab = saved.tab ?? "pipelines";
    this.profiles = [];
    this.region = InputState.new({ value: isRegion(saved.region) ? saved.region : "", placeholder: "region (profile default)" });
    this.region.on("submit", (_e, cx) => this.reload(cx));
    this.filter = InputState.new({ value: "", placeholder: "filter" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.pin = saved.pin; // undefined = follow focus; null = local; string = that machine
    this.range = saved.range ?? "1h";
    this.pattern = InputState.new({ value: "", placeholder: "filter pattern (e.g. ERROR, \"exact\", { $.level = \"error\" })" });
    this.pattern.on("submit", (_e, cx) => this.loadEvents(cx));
    this.on = undefined;
  }

  close() {
    this.region.release();
    this.filter.release();
    this.pattern.release();
  }

  save() {
    setShared("my-aws", { profile: this.profile, tab: this.tab, region: regionOf(this.region), pin: this.pin, range: this.range });
  }

  // Runs one aws call; drops the result if machine/profile/region changed meanwhile.
  run(cx, args, done) {
    const key = [this.on, this.profile, regionOf(this.region)].join("|");
    this.loading = true;
    this.error = null;
    cx.spawn(async cx => {
      try {
        const data = await aws(this.on, this.profile, regionOf(this.region), args);
        if (key === [this.on, this.profile, regionOf(this.region)].join("|")) done(data);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
      cx.notify();
    });
  }

  reload(cx) {
    this.save();
    this.pipelines = this.pipeline = this.state = null;
    this.groups = this.group = this.streams = this.stream = this.events = null;
    if (this.tab === "pipelines") this.run(cx, ["codepipeline", "list-pipelines"], d => (this.pipelines = d.pipelines ?? []));
    else this.loadGroups(cx);
  }

  loadGroups(cx) {
    this.group = this.streams = this.stream = this.events = null;
    this.run(cx, ["logs", "describe-log-groups", "--max-items", "1000"], d => (this.groups = d.logGroups ?? []));
  }

  // Live case-insensitive substring match on the list being shown.
  match(name) {
    const q = this.filter.value().trim().toLowerCase();
    return !q || name.toLowerCase().includes(q);
  }

  openPipeline(name, cx) {
    this.filter.set_value("");
    this.pipeline = name;
    this.state = null;
    this.run(cx, ["codepipeline", "get-pipeline-state", "--name", name], d => (this.state = d));
  }

  openGroup(name, cx) {
    this.filter.set_value("");
    this.group = name;
    this.streams = this.stream = null;
    this.showStreams = false;
    this.loadEvents(cx);
  }

  openStreams(cx) {
    this.filter.set_value("");
    this.showStreams = true;
    this.streams = null;
    this.run(cx, ["logs", "describe-log-streams", "--log-group-name", this.group, "--order-by", "LastEventTime", "--descending", "--max-items", "200"], d => (this.streams = d.logStreams ?? []));
  }

  openStream(name, cx) {
    this.showStreams = false;
    this.stream = name;
    this.loadEvents(cx);
  }

  // Every stream of the group (or the one picked stream) in the chosen range, through the
  // server-side CloudWatch filter pattern. Oldest first, capped at MAX_EVENTS.
  loadEvents(cx) {
    const ms = RANGES.find(([k]) => k === this.range)?.[1] ?? 36e5;
    const pattern = this.pattern.value().trim();
    this.events = null;
    this.truncated = false;
    this.run(
      cx,
      ["logs", "filter-log-events", "--log-group-name", this.group, "--start-time", String(Date.now() - ms), "--max-items", String(MAX_EVENTS),
        ...(this.stream ? ["--log-stream-names", this.stream] : []), ...(pattern ? ["--filter-pattern", pattern] : [])],
      d => {
        this.events = d.events ?? [];
        this.truncated = Boolean(d.NextToken ?? d.nextToken);
      },
    );
  }

  // Machine change: refetch its profiles, keep the chosen one when that machine has it.
  sync(cx) {
    const on = this.pin === undefined ? machine() : this.pin;
    if (on === this.on) return;
    this.on = on;
    this.profiles = [];
    cx.spawn(async cx => {
      const r = await exec("aws", ["configure", "list-profiles"], { on }).catch(() => null);
      if (this.on !== on) return;
      this.profiles = r?.code === 0 ? r.stdout.split("\n").map(s => s.trim()).filter(Boolean) : [];
      if (!this.profiles.includes(this.profile)) this.profile = this.profiles.includes("default") ? "default" : (this.profiles[0] ?? null);
      this.reload(cx);
      cx.notify();
    });
  }

  render(cx) {
    this.sync(cx);
    const t = theme();
    const chip = (id, label, active, click) =>
      div()
        .id(id)
        .px(8)
        .py(2)
        .rounded(6)
        .text_size(12)
        .when(active, e => e.bg(t.selected))
        .hover(s => s.bg(t.selected))
        .on_click((_e, cx) => click(cx))
        .child(label);
    const row = (id, click) => h_flex().id(id).px(10).py(4).gap(8).items_center().rounded(6).hover(s => s.bg(t.selected)).on_click((_e, cx) => click(cx));
    const back = (label, click) => row("aws-back", click).text_color(t.dim).child(`← ${label}`);
    const pinTo = name => cx => {
      this.pin = name;
      this.save();
      this.sync(cx);
      cx.notify();
    };
    const pick = profile => cx => {
      this.profile = profile;
      this.reload(cx);
    };
    const tab = name => cx => {
      this.tab = name;
      this.reload(cx);
    };

    return v_flex()
      .id("my-aws")
      .size_full()
      .bg(t.background)
      .text_size(12.8)
      .child(
        v_flex()
          .p(8)
          .gap(6)
          .border_b_1()
          .border_color(t.border)
          .child(
            h_flex()
              .gap(4)
              .flex_wrap()
              .items_center()
              .child(div().text_color(t.dim).text_size(12).child("machine"))
              .child(chip("aws-m-follow", "follow focus", this.pin === undefined, pinTo(undefined)))
              .children(machines().map(m => chip(`aws-m-${m.name ?? "local"}`, `📌 ${m.name ?? "local"}`, this.pin === m.name, pinTo(m.name)))),
          )
          .child(
            h_flex()
              .gap(4)
              .flex_wrap()
              .items_center()
              .child(div().text_color(t.dim).text_size(12).child(`${this.on ?? "local"} ·`))
              .children(this.profiles.map(p => chip(`aws-p-${p}`, p, p === this.profile, pick(p))))
              .when(!this.profiles.length, e => e.child(div().text_color(t.dim).text_size(12).child("no aws profiles"))),
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(chip("aws-t-p", "Pipelines", this.tab === "pipelines", tab("pipelines")))
              .child(chip("aws-t-l", "Logs", this.tab === "logs", tab("logs")))
              .child(div().flex_1().child(Input.new(this.region).h(24).text_size(12)))
              .child(chip("aws-refresh", this.loading ? "…" : "↻", false, cx => this.refresh(cx))),
          ),
      )
      .when(this.error, e => e.child(div().p(10).text_color(t.ansi1).text_size(12).child(this.error)))
      .child(
        v_flex()
          .id("aws-body")
          .flex_1()
          .min_h(0)
          .p(4)
          .overflow_y_scrollbar()
          .children(this.tab === "pipelines" ? this.pipelineView(t, row, back) : this.logsView(t, row, back)),
      );
  }

  // ↻ refreshes the deepest open view rather than resetting to the list.
  refresh(cx) {
    if (this.tab === "pipelines" && this.pipeline) return this.openPipeline(this.pipeline, cx);
    if (this.tab === "logs" && this.group) return this.showStreams ? this.openStreams(cx) : this.loadEvents(cx);
    this.reload(cx);
  }

  pipelineView(t, row, back) {
    if (!this.pipeline)
      return [this.filterBox(), ...(this.pipelines ?? []).filter(p => this.match(p.name)).map(p =>
        row(`aws-pl-${p.name}`, cx => this.openPipeline(p.name, cx))
          .child(div().flex_1().child(p.name))
          .child(div().text_color(t.dim).text_size(11.5).child(ago(time(p.updated)))),
      )];
    const region = regionOf(this.region);
    const url = `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${encodeURIComponent(this.pipeline)}/view${region ? `?region=${region}` : ""}`;
    const out = [
      h_flex()
        .child(back(this.pipeline, cx => (this.pipeline = this.state = null, cx.notify())).flex_1())
        .child(row("aws-console", cx => cx.open_url(url)).text_color(t.dim).child("Console ↗")),
    ];
    for (const s of this.state?.stageStates ?? []) {
      const ex = s.latestExecution ?? {};
      const [g, c] = STATUS[ex.status] ?? ["○", "dim"];
      out.push(
        v_flex()
          .m(4)
          .p(8)
          .gap(4)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .child(div().text_color(t[c]).child(g))
              .child(div().flex_1().child(s.stageName))
              .when(s.inboundTransitionState?.enabled === false, e => e.child(div().text_color(t.ansi3).text_size(11.5).child("transition disabled"))),
          )
          .children(
            (s.actionStates ?? []).map(a => {
              const ax = a.latestExecution ?? {};
              const [ag, ac] = STATUS[ax.status] ?? ["○", "dim"];
              const rev = a.currentRevision?.revisionId ?? ax.externalExecutionId;
              return v_flex()
                .pl(14)
                .child(
                  h_flex()
                    .gap(6)
                    .child(div().text_color(t[ac]).child(ag))
                    .child(div().flex_1().child(a.actionName))
                    .when(ax.lastStatusChange, e => e.child(div().text_color(t.dim).text_size(11.5).child(ago(time(ax.lastStatusChange))))),
                )
                .when(rev, e => e.child(div().pl(16).text_color(t.dim).text_size(11.5).child(String(rev).slice(0, 12))))
                .when(ax.status === "Failed" && ax.errorDetails?.message, e => e.child(div().pl(16).text_color(t.ansi1).text_size(11.5).child(ax.errorDetails.message)))
                .when(ax.externalExecutionUrl, e =>
                  e.child(div().id(`aws-x-${a.actionName}`).pl(16).text_color(t.dim).text_size(11.5).hover(s => s.text_color(t.foreground)).on_click((_e, cx) => cx.open_url(ax.externalExecutionUrl)).child("Details ↗")),
                );
            }),
          ),
      );
    }
    return out;
  }

  filterBox() {
    return div().px(6).py(4).child(Input.new(this.filter).h(24).text_size(12));
  }

  logsView(t, row, back) {
    if (this.group && this.showStreams)
      return [
        back("all streams", cx => (this.showStreams = false, cx.notify())),
        this.filterBox(),
        ...(this.streams ?? []).filter(s => this.match(s.logStreamName)).map(s =>
          row(`aws-ls-${s.logStreamName}`, cx => this.openStream(s.logStreamName, cx))
            .child(div().flex_1().min_w(0).text_ellipsis().child(s.logStreamName))
            .child(div().text_color(t.dim).text_size(11.5).child(s.lastEventTimestamp ? ago(s.lastEventTimestamp) : "")),
        ),
      ];
    if (this.group) {
      const mono = settings().font_family ?? "JetBrains Mono";
      const small = (id, label, active, click) =>
        div().id(id).px(6).py(1).rounded(5).text_size(11.5).when(active, e => e.bg(t.selected)).hover(s => s.bg(t.selected)).on_click((_e, cx) => click(cx)).child(label);
      const multi = !this.stream;
      return [
        h_flex()
          .child(back(this.group, cx => (this.group = this.stream = this.events = null, cx.notify())).flex_1())
          .child(small("aws-streams", "Streams…", false, cx => this.openStreams(cx))),
        h_flex()
          .px(6)
          .gap(4)
          .items_center()
          .child(small("aws-s-all", "all streams", multi, cx => (this.stream = null, this.loadEvents(cx))))
          .when(this.stream, e => e.child(div().flex_1().min_w(0).text_ellipsis().text_size(11.5).child(this.stream)))
          .when(multi, e => e.child(div().flex_1())),
        h_flex()
          .px(6)
          .gap(2)
          .children(RANGES.map(([k]) => small(`aws-r-${k}`, k, this.range === k, cx => (this.range = k, this.save(), this.loadEvents(cx))))),
        div().px(6).py(4).child(Input.new(this.pattern).h(24).text_size(12)),
        div()
          .px(10)
          .text_size(11.5)
          .text_color(t.dim)
          .child(this.events ? `${this.events.length} events, last ${this.range}${this.truncated ? ` (first ${MAX_EVENTS} only; narrow the range or pattern)` : ""}` : "loading…"),
        ...(this.events ?? []).map((ev, i) =>
          v_flex()
            .id(`aws-ev-${i}`)
            .px(10)
            .py(1)
            .font_family(mono)
            .text_size(11.5)
            .child(
              h_flex()
                .gap(8)
                .items_start()
                .child(div().flex_none().text_color(t.dim).child(new Date(ev.timestamp).toISOString().slice(5, 19).replace("T", " ")))
                .child(div().flex_1().min_w(0).child(ev.message.trimEnd())),
            )
            .when(multi && ev.logStreamName, e => e.child(div().pl(16).text_color(t.dim).text_size(10.5).text_ellipsis().child(ev.logStreamName))),
        ),
      ];
    }
    return [
      this.filterBox(),
      ...(this.groups ?? []).filter(g => this.match(g.logGroupName)).map(g =>
        row(`aws-lg-${g.logGroupName}`, cx => this.openGroup(g.logGroupName, cx)).child(div().flex_1().min_w(0).text_ellipsis().child(g.logGroupName)),
      ),
    ];
  }
}
