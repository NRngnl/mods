// AWS panel: CodePipeline state and CloudWatch Logs, read-only, through the `aws` CLI on the
// focused machine. Credentials are whatever that CLI resolves (profiles, SSO, env).
import { View, div, list, uniform_list } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar } from "gpui-base";
import { spaces, focused, exec, theme, settings, shared, setShared, machines, window, hc, home, notify, writeTextFile } from "herdr";

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
const RANGES = ["5m", "15m", "1h", "3h", "12h", "1d", "1w"];
const UNIT = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
// "90m", "2h", "3d" → milliseconds; null when not a relative range.
const relMs = v => {
  const m = /^(\d+)\s*([smhdw])$/.exec((v ?? "").trim().toLowerCase());
  return m && +m[1] > 0 ? +m[1] * UNIT[m[2]] : null;
};
// Local time "2025-01-31 14:00[:ss]" or a date alone (midnight); null when invalid.
const absMs = v => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec((v ?? "").trim());
  if (!m) return null;
  const d = new Date(+m[1], m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return d.getMonth() === m[2] - 1 && d.getDate() === +m[3] ? d.getTime() : null;
};
const MAX_EVENTS = 2000;
// Local time "YYYY-MM-DD HH:MM:SS.mmm".
const pad = (n, w = 2) => String(n).padStart(w, "0");
const local = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const evKey = ev => ev.eventId ?? `${ev.timestamp}-${ev.logStreamName}-${ev.ingestionTime}`;
const time = v => (v == null ? 0 : typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

// ssh target of a herdr machine, for scp of exported logs.
async function sshTarget(name) {
  const r = await hc(["machine", "ls", "--json"]);
  const t = JSON.parse(r.stdout).machines.find(m => m.name === name)?.target;
  if (!t) throw new Error(`No ssh target for ${name}`);
  return t;
}

// Absolute path and subfolders of `dir` ("" = home) on machine `on`.
async function listDirs(on, dir) {
  const r = await exec("sh", ["-c", 'cd "${1:-$HOME}" && pwd && ls -1Ap | sed -n "s:/$::p"', "x", dir], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot open ${dir || "home"}`);
  const [path, ...dirs] = r.stdout.split("\n").filter(Boolean);
  return { path, dirs };
}

// A list that fills the remaining height and builds only the rows on screen; long log views
// (thousands of rows) stay responsive. Rows can't carry handlers: clicks go through onClick(key).
function scroller(id, items, key, render, onClick, uniform = true) {
  const l = uniform
    ? uniform_list(id, items.length, i => key(items[i]), (rg, cx) => items.slice(rg.start, rg.end).map(x => render(x, cx)))
    : list(id, items.length, i => key(items[i]), (i, cx) => render(items[i], cx));
  return v_flex()
    .relative()
    .flex_1()
    .min_h(0)
    .child(l.size_full().when(onClick, e => e.on_item_click((k, cx) => onClick(k, cx))))
    .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
}

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
    this.rel = InputState.new({ value: RANGES.includes(this.range) || this.range === "abs" ? "" : this.range, placeholder: "custom: 30m, 6h, 2d" });
    this.rel.on("submit", (_e, cx) => {
      if (!relMs(this.rel.value())) return (this.error = "Relative range: a number and s, m, h, d or w, like 30m", cx.notify());
      this.range = this.rel.value().trim().toLowerCase();
      this.save();
      this.loadEvents(cx);
    });
    this.from = InputState.new({ value: saved.from ?? "", placeholder: "from YYYY-MM-DD HH:MM" });
    this.to = InputState.new({ value: saved.to ?? "", placeholder: "to (empty = now)" });
    const abs = (_e, cx) => {
      this.range = "abs";
      this.save();
      this.loadEvents(cx);
    };
    this.from.on("submit", abs);
    this.to.on("submit", abs);
    this.exportDirs = saved.exportDirs ?? {}; // last folder per machine ("" key = local)
    this.exportOn = saved.exportOn ?? null;
    this.exName = InputState.new({ placeholder: "file name" });
    this.newDir = InputState.new({ placeholder: "new folder name" });
    this.newDir.on("submit", (_e, cx) => this.makeDir(cx));
    this.on = undefined;
  }

  // Row selection like cpv's yank: click a row to select it, click another to extend to a range,
  // click the only selected row to clear. Copy takes the raw messages only, not time or stream.
  pickRow(key, cx) {
    const i = (this.events ?? []).findIndex(ev => evKey(ev) === key);
    if (i < 0) return;
    if (this.sel && this.sel[0] === this.sel[1] && this.sel[0] === i) this.sel = null;
    else if (this.sel && this.sel[0] === this.sel[1]) this.sel = [Math.min(this.sel[0], i), Math.max(this.sel[0], i)];
    else this.sel = [i, i];
    cx.notify();
  }

  copyRows(cx) {
    if (!this.sel) return;
    cx.write_to_clipboard(this.events.slice(this.sel[0], this.sel[1] + 1).map(ev => ev.message.trimEnd()).join("\n"));
    this.copied = this.sel[1] - this.sel[0] + 1;
    cx.notify();
  }

  close() {
    this.watchGen = (this.watchGen ?? 0) + 1;
    this.region.release();
    this.filter.release();
    this.pattern.release();
    this.rel.release();
    this.from.release();
    this.to.release();
    this.exName.release();
    this.newDir.release();
  }

  save() {
    setShared("my-aws", { profile: this.profile, tab: this.tab, region: regionOf(this.region), pin: this.pin, range: this.range, from: this.from.value().trim(), to: this.to.value().trim(), exportDirs: this.exportDirs, exportOn: this.exportOn });
  }

  // Runs one aws call; drops the result if machine/profile/region changed meanwhile.
  // No timers anywhere: every call comes from a click. A click repeating the call already in
  // flight is dropped, and the header counts calls made this session.
  run(cx, args, done) {
    const key = [this.on, this.profile, regionOf(this.region)].join("|");
    const sig = key + "|" + args.join(" ");
    if (this.inflight === sig) return;
    this.inflight = sig;
    this.calls = (this.calls ?? 0) + 1;
    this.loading = true;
    this.error = null;
    cx.spawn(async cx => {
      try {
        const data = await aws(this.on, this.profile, regionOf(this.region), args);
        if (key === [this.on, this.profile, regionOf(this.region)].join("|")) {
          done(data);
          (this.seen ??= new Map()).set(key, { pipelines: this.pipelines, groups: this.groups });
        }
      } catch (e) {
        this.error = e.message;
      }
      if (this.inflight === sig) this.inflight = null;
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
    this.watch(name, cx);
  }

  // Live like the web console: poll get-pipeline-state while the pipeline is open (CodePipeline
  // has no per-request charge). Every 3 s with the app focused, 30 s in the background, like a
  // browser throttling a background tab. Stops when leaving the pipeline, the tab or the panel.
  watch(name, cx) {
    const gen = (this.watchGen = (this.watchGen ?? 0) + 1);
    this.watching = true;
    cx.spawn(async cx => {
      let last = Date.now();
      while (true) {
        await cx.sleep(3000);
        if (gen !== this.watchGen || this.pipeline !== name || this.tab !== "pipelines") break;
        if (!window().active && Date.now() - last < 30e3) continue;
        last = Date.now();
        this.run(cx, ["codepipeline", "get-pipeline-state", "--name", name], d => this.pipeline === name && (this.state = d));
      }
      if (gen === this.watchGen) this.watching = false;
      cx.notify();
    });
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
  // filter-log-events args for the current group/stream/range/pattern; null (with this.error) when invalid.
  queryArgs() {
    let start, end;
    if (this.range === "abs") {
      start = absMs(this.from.value());
      end = this.to.value().trim() ? absMs(this.to.value()) : Date.now();
      if (start == null || end == null || start >= end) {
        this.error = "Absolute range: from (and optional to) as YYYY-MM-DD HH:MM local time, from before to";
        return null;
      }
    } else start = Date.now() - (relMs(this.range) ?? 36e5);
    const pattern = this.pattern.value().trim();
    return ["logs", "filter-log-events", "--log-group-name", this.group, "--start-time", String(start), ...(end ? ["--end-time", String(end)] : []),
      ...(this.stream ? ["--log-stream-names", this.stream] : []), ...(pattern ? ["--filter-pattern", pattern] : [])];
  }

  loadEvents(cx) {
    const args = this.queryArgs();
    if (!args) return;
    this.events = null;
    this.truncated = false;
    this.run(
      cx,
      [...args, "--max-items", String(MAX_EVENTS)],
      d => {
        this.events = d.events ?? [];
        this.sel = null;
        this.truncated = Boolean(d.NextToken ?? d.nextToken);
      },
    );
  }

  // Export: a folder browser on any machine, starting at the last folder saved there.
  browse(on, dir, cx) {
    this.exportOn = on;
    this.exBusy = true;
    cx.spawn(async cx => {
      try {
        const r = await listDirs(on, dir);
        if (this.exportOn === on) Object.assign(this, { exPath: r.path, exDirs: r.dirs });
      } catch (e) {
        if (dir) return this.browse(on, "", cx); // remembered folder gone: fall back to home
        this.error = e.message;
      }
      this.exBusy = false;
      cx.notify();
    });
  }

  openExport(cx) {
    const stamp = local(Date.now()).slice(0, 19).replace(/[: ]/g, "-");
    this.exName.set_value(`${this.group.replace(/[^\w.-]+/g, "_").replace(/^_+/, "")}${this.stream ? "_" + this.stream.replace(/[^\w.-]+/g, "_") : ""}_${stamp}.log`);
    this.exporting = true;
    this.confirm = null;
    this.browse(this.exportOn, this.exportDirs[this.exportOn ?? ""] ?? "", cx);
  }

  makeDir(cx) {
    const name = this.newDir.value().trim();
    if (!name || name.includes("/") || name === "." || name === "..") return;
    const on = this.exportOn,
      path = `${this.exPath === "/" ? "" : this.exPath}/${name}`;
    cx.spawn(async cx => {
      const r = await exec("mkdir", [path], { on });
      if (r.code !== 0) this.error = r.stderr.trim() || "mkdir failed";
      else {
        this.newDir.set_value("");
        this.browse(on, path, cx);
      }
      cx.notify();
    });
  }

  // Asks before replacing an existing file; `force` is the Overwrite answer.
  saveExport(cx, force = false) {
    const name = this.exName.value().trim();
    if (!name || name.includes("/")) return (this.error = "File name must not be empty or contain /", cx.notify());
    const on = this.exportOn,
      dest = `${this.exPath === "/" ? "" : this.exPath}/${name}`;
    cx.spawn(async cx => {
      if (!force && (await exec("test", ["-e", dest], { on })).code === 0) {
        this.confirm = dest;
        return cx.notify();
      }
      this.confirm = null;
      this.exportDirs = { ...this.exportDirs, [on ?? ""]: this.exPath };
      this.exporting = false;
      this.save();
      cx.notify();
      this.exportAll(on, dest, cx);
    });
  }

  // Every matching event, not just the loaded ones: the CLI pages through all results on the AWS
  // machine into a temp file ("time<TAB>stream<TAB>message" lines), then it moves or scp's it.
  exportAll(on, dest, cx) {
    const args = this.queryArgs();
    if (!args) return;
    const src = this.on,
      region = regionOf(this.region);
    const tmp = `.my-aws-export-${Date.now()}.log`;
    const opts = [...(this.profile ? ["--profile", this.profile] : []), ...(region ? ["--region", region] : [])];
    notify({ title: "Exporting log", body: `${this.group} → ${on ?? "local"}:${dest}`, timeout: 4000 });
    cx.spawn(async () => {
      try {
        const q = await exec("sh", ["-c", `cd "$HOME" && t=$1 && shift && aws "$@" > "$t.raw" || { s=$?; rm -f "$t.raw"; exit $s; }
if command -v perl >/dev/null; then perl -MPOSIX -pe 's/^(\\d+)(\\d{3})\t/strftime("%Y-%m-%d %H:%M:%S",localtime($1)).".$2".strftime("%z",localtime($1))."\t"/e' "$t.raw" > "$t"; else mv "$t.raw" "$t"; fi
rm -f "$t.raw"; wc -l < "$t"`, "x", tmp, ...args, ...opts, "--output", "text", "--query", "events[].[timestamp,logStreamName,message]"], { on: src });
        if (q.code !== 0) throw new Error(q.stderr.trim().slice(0, 300) || "aws failed");
        if (src === on) {
          const r = await exec("sh", ["-c", 'mv -f "$HOME/$1" "$2"', "x", tmp, dest], { on });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "move failed");
        } else {
          const at = async (m, p) => (m == null ? (p.startsWith("/") ? p : `${home()}/${p}`) : `${await sshTarget(m)}:${p}`);
          const r = await exec("scp", ["-3", "-o", "BatchMode=yes", await at(src, tmp), await at(on, dest)]);
          await exec("sh", ["-c", 'rm -f "$HOME/$1"', "x", tmp], { on: src });
          if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 300) || "scp failed");
        }
        notify({ title: "Log exported", body: `${q.stdout.trim()} events → ${on ?? "local"}:${dest}`, timeout: 6000 });
      } catch (e) {
        notify({ title: "Log export failed", body: String(e.message ?? e), level: "error" });
      }
    });
  }

  exportView(t, row, back) {
    const small = (id, label, active, click) =>
      div().id(id).px(6).py(1).rounded(5).text_size(11.5).when(active, e => e.bg(t.selected)).hover(s => s.bg(t.selected)).on_click((_e, cx) => click(cx)).child(label);
    const path = this.exPath ?? "";
    return [
      back("cancel export", cx => (this.exporting = this.confirm = false, cx.notify())),
      h_flex()
        .px(6)
        .gap(4)
        .flex_wrap()
        .children(machines().map(m => small(`aws-xm-${m.name ?? "local"}`, m.name ?? "local", this.exportOn === m.name, cx => this.browse(m.name, this.exportDirs[m.name ?? ""] ?? "", cx)))),
      h_flex()
        .px(10)
        .py(4)
        .gap(8)
        .items_center()
        .child(div().flex_1().min_w(0).text_ellipsis_start().text_size(11.5).child(this.exBusy ? "…" : path)),
      h_flex()
        .px(6)
        .gap(4)
        .items_center()
        .child(div().flex_1().child(Input.new(this.exName).h(22).text_size(11.5)))
        .child(small("aws-x-save", "Save all matching here", true, cx => this.exPath && this.saveExport(cx))),
      this.confirm
        ? h_flex()
            .px(10)
            .py(4)
            .gap(6)
            .items_center()
            .child(div().flex_1().min_w(0).text_color(t.ansi3).text_size(11.5).child(`${this.confirm.split("/").pop()} already exists.`))
            .child(small("aws-x-over", "Overwrite", false, cx => this.saveExport(cx, true)))
            .child(small("aws-x-cancel", "Cancel", false, cx => (this.confirm = null, cx.notify())))
        : div(),
      h_flex()
        .px(6)
        .gap(4)
        .items_center()
        .child(div().flex_1().child(Input.new(this.newDir).h(22).text_size(11.5)))
        .child(small("aws-x-mkdir", "New folder", false, cx => this.makeDir(cx))),
      path !== "/" && path ? row("aws-x-up", cx => this.browse(this.exportOn, path.replace(/\/[^/]*$/, "") || "/", cx)).text_color(t.dim).child("📁 ..") : div(),
      ...(this.exDirs ?? []).map(d => row(`aws-x-d-${d}`, cx => this.browse(this.exportOn, `${path === "/" ? "" : path}/${d}`, cx)).child(`📁 ${d}`)),
    ];
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
      // Following focus between machines must not call AWS each time: reuse what this
      // machine/profile/region last loaded; only a first visit or ↻ fetches.
      const seen = this.seen?.get([on, this.profile, regionOf(this.region)].join("|"));
      if (seen) Object.assign(this, { pipelines: seen.pipelines, groups: seen.groups, pipeline: null, state: null, group: null, stream: null, events: null });
      else this.reload(cx);
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
              .child(div().text_color(t.dim).text_size(12).child(`${this.on ?? "local"} · ${this.calls ?? 0} calls ·`))
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
          .when(this.tab === "pipelines" || this.exporting, e => e.overflow_y_scrollbar())
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
        .child(back(this.pipeline, cx => (this.pipeline = this.state = null, this.watchGen++, cx.notify())).flex_1())
        .child(div().text_size(11.5).text_color(this.watching ? t.ansi2 : t.dim).child(this.watching ? (window().active ? "● live" : "● live (30 s)") : "○ paused, ↻ to resume"))
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
    if (this.group && this.exporting) return this.exportView(t, row, back);
    if (this.group && this.showStreams)
      return [
        back("all streams", cx => (this.showStreams = false, cx.notify())),
        this.filterBox(),
        scroller(
          "aws-streams-list",
          (this.streams ?? []).filter(s => this.match(s.logStreamName)),
          s => s.logStreamName,
          s =>
            h_flex().px(10).py(4).gap(8).items_center().rounded(6).hover(h => h.bg(t.selected))
              .child(div().flex_1().min_w(0).text_ellipsis().child(s.logStreamName))
              .child(div().text_color(t.dim).text_size(11.5).child(s.lastEventTimestamp ? ago(s.lastEventTimestamp) : "")),
          (k, cx) => this.openStream(k, cx),
        ),
      ];
    if (this.group) {
      const small = (id, label, active, click) =>
        div().id(id).px(6).py(1).rounded(5).text_size(11.5).when(active, e => e.bg(t.selected)).hover(s => s.bg(t.selected)).on_click((_e, cx) => click(cx)).child(label);
      const multi = !this.stream;
      return [
        h_flex()
          .child(back(this.group, cx => (this.group = this.stream = this.events = null, cx.notify())).flex_1())
          .when(this.events?.length, e => e.child(small("aws-export", "Export…", false, cx => this.openExport(cx))))
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
          .items_center()
          .children(RANGES.map(k => small(`aws-r-${k}`, k, this.range === k, cx => (this.range = k, this.save(), this.loadEvents(cx)))))
          .child(div().w(90).child(Input.new(this.rel).h(22).text_size(11.5)))
          .when(relMs(this.range) && !RANGES.includes(this.range), e => e.child(div().text_size(11.5).text_color(t.foreground).child(`● ${this.range}`))),
        h_flex()
          .px(6)
          .gap(4)
          .items_center()
          .child(small("aws-r-abs", "absolute", this.range === "abs", cx => (this.range = "abs", this.save(), this.loadEvents(cx))))
          .child(div().flex_1().child(Input.new(this.from).h(22).text_size(11.5)))
          .child(div().flex_1().child(Input.new(this.to).h(22).text_size(11.5))),
        div().px(6).py(4).child(Input.new(this.pattern).h(24).text_size(12)),
        div()
          .px(10)
          .text_size(11.5)
          .text_color(t.dim)
          .child(this.events ? `${this.events.length} events, ${this.range === "abs" ? `${this.from.value().trim()} → ${this.to.value().trim() || "now"}` : `last ${this.range}`}${this.truncated ? ` (first ${MAX_EVENTS} only; narrow the range or pattern)` : ""}` : "loading…"),
        h_flex()
          .px(10)
          .gap(6)
          .items_center()
          .text_size(11.5)
          .text_color(t.dim)
          .child(div().flex_1().child(this.sel ? `${this.sel[1] - this.sel[0] + 1} line(s) selected` : "click a row to select, another to extend"))
          .when(this.sel, e => e.child(small("aws-copy", this.copied ? `Copied ${this.copied}` : "Copy messages", false, cx => this.copyRows(cx))))
          .when(this.sel, e => e.child(small("aws-unsel", "Clear", false, cx => (this.sel = null, cx.notify())))),
        scroller(
          "aws-events",
          this.events ?? [],
          evKey,
          ev => {
            const i = this.events.indexOf(ev);
            const on = this.sel && i >= this.sel[0] && i <= this.sel[1];
            return h_flex()
              .px(10)
              .py(1)
              .gap(10)
              .items_start()
              .font_family(settings().font_family ?? "JetBrains Mono")
              .text_size(11.5)
              .when(on, e => e.bg(t.selected))
              .child(div().flex_none().text_color(t.dim).child(local(ev.timestamp).slice(5)))
              .when(multi && ev.logStreamName, e => e.child(div().flex_none().w(140).text_color(t.dim).text_ellipsis().child(ev.logStreamName)))
              .child(div().flex_1().min_w(0).child(ev.message.trimEnd()));
          },
          (k, cx) => (this.copied = 0, this.pickRow(k, cx)),
          false,
        ),
      ];
    }
    return [
      this.filterBox(),
      scroller(
        "aws-groups",
        (this.groups ?? []).filter(g => this.match(g.logGroupName)),
        g => g.logGroupName,
        g => h_flex().px(10).py(4).items_center().rounded(6).hover(h => h.bg(t.selected)).child(div().flex_1().min_w(0).text_ellipsis().child(g.logGroupName)),
        (k, cx) => this.openGroup(k, cx),
      ),
    ];
  }
}
