import { View, div, svg } from "gpui-kit";
import { Button, Input, InputState, Popup, ScrollHandle, Select, h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, hc, panes, props, setShared, settings, shared, spaces, terminals, theme } from "herdr";
import { dispatch } from "./dispatch.js";
import { groupSpaceOptions, readSpaceRepo, spaceLocations } from "./space-options.js";

const KEY = "command-runner.commands";
const saved = () => shared(KEY) ?? ["pnpm dev"];
const fields = { command: "Command", space: "Space", tab: "Tab", terminal: "Terminal" };
const forTab = (list, id) => list.filter(p => p.tab === id && p.terminal);
const agentLabel = app => app === "omp" ? "OMP" : app;
const menuContext = "CommandRunnerOptions";
let menuKeysBound = false;
const missing = Symbol("missing selection");
const icon = (name, size = 14) => svg(`mods/workspace-chrome/${name}.svg`).size(size).flex_none();
const mono = () => settings().font_family ?? "JetBrains Mono";

function button(id, text, action, { disabled = false, primary = false, label = text, glyph } = {}) {
  const t = theme();
  return Button.new(id).accessibility_label(label).tab_stop(!disabled).disabled(disabled)
    .h(32).px(text ? 10 : 7).flex_none().items_center().justify_center().rounded(5).border_1().border_color("#00000000")
    .when(primary, el => el.bg(disabled ? t.raised : t.accent))
    .text_color(disabled ? t.muted : primary ? t.accent_foreground : t.foreground)
    .when(!disabled, el => el.cursor_pointer().hover(s => primary ? s.border_color(t.foreground) : s.bg(t.hover)))
    .focus(s => s.border_color(t.ring)).tooltip(label)
    .on_click((_, cx) => { if (!disabled) { action(cx); cx.notify(); } })
    .child(h_flex().gap(6).items_center().when(glyph, el => el.child(icon(glyph)))
      .when(text, el => el.child(div().font_medium().child(text))));
}

export default class CommandRunner extends View {
  init(_props, cx) {
    if (!menuKeysBound) {
      cx.bind_keys([
        { keystroke: "tab", action: "command-runner.next-field", context: menuContext },
        { keystroke: "shift-tab", action: "command-runner.previous-field", context: menuContext },
        { keystroke: "up", action: "command-runner.previous-match", context: menuContext },
        { keystroke: "down", action: "command-runner.next-match", context: menuContext },
        { keystroke: "enter", action: "command-runner.accept-match", context: menuContext },
        { keystroke: "escape", action: "command-runner.dismiss-search", context: menuContext },
      ]);
      menuKeysBound = true;
    }
    this.serial = 0;
    this.formFocus = cx.focus_handle();
    this.listFocus = cx.focus_handle();
    this.listScroll = ScrollHandle.new();
    this.search = InputState.new({ placeholder: "Type to filter…" });
    this.search.on("change", (_, cx) => {
      if (!this.dropdown) return;
      this.dropdown.active = null;
      this.listScroll.scroll_to_item(0);
      cx.notify();
    });
    this.search.on("submit", (_, cx) => this.acceptMatch(cx));
    this.rows = [this.newRow(saved()[0] ?? "", cx)];
    if (_props?.overlay) (this.rows[0].command ? this.rows[0].focus.command : this.formFocus).focus();
    this.input = InputState.new({ placeholder: "Command, e.g. pnpm dev or /restart" });
    this.input.on("change", (_, cx) => cx.notify());
    this.input.on("submit", (_, cx) => { if (this.manage) this.save(); cx.notify(); });
    this.repoByLocation = new Map();
    this.pendingRepoLocations = new Set();
    this.refreshSpaceRepos(cx);
  }

  newRow(command, cx) {
    const focus = Object.fromEntries(Object.keys(fields).map(key => [key, cx.focus_handle()]));
    return { id: ++this.serial, command, space: "", tab: "", terminal: "", agent: null, result: "", sent: false, focus };
  }

  save() {
    const cmd = this.input.value().trim();
    if (!cmd || /[\x00-\x1f\x7f]/.test(cmd) || saved().includes(cmd)) return;
    setShared(KEY, [...saved(), cmd]);
    if (!this.rows[0].command) this.rows[0].command = cmd;
    this.input.set_value("");
  }

  choose(row, key, value) {
    row[key] = value;
    if (key === "space") row.tab = "";
    if (key !== "command") {
      const candidates = forTab(panes(), row.tab);
      if (key !== "terminal") row.terminal = candidates.length === 1 ? candidates[0].terminal : "";
      row.agent = candidates.find(p => p.terminal === row.terminal)?.app ?? null;
    }
    row.sent = false;
    row.result = "";
  }

  refreshSpaceRepos(cx) {
    if (checking()) return;
    const fresh = [];
    for (const location of spaceLocations(spaces(), panes()).values()) {
      if (this.repoByLocation.has(location.key) || this.pendingRepoLocations.has(location.key)) continue;
      this.pendingRepoLocations.add(location.key);
      fresh.push(location);
    }
    if (!fresh.length) return;
    cx.spawn(async cx => {
      const repos = await Promise.all(fresh.map(location => readSpaceRepo(location, exec)));
      const active = this.dropdown?.key === "space" && this.dropdown.active;
      let activeIndex;
      if (active) {
        const ss = spaces(), ps = panes();
        activeIndex = () => this.matches(this.spaceChoices(ss, ps)).findIndex(([value]) => value === active);
      }
      const before = activeIndex?.();
      for (let i = 0; i < fresh.length; i++) {
        const key = fresh[i].key;
        this.repoByLocation.set(key, repos[i]);
        this.pendingRepoLocations.delete(key);
      }
      const after = activeIndex?.();
      if (after >= 0 && after !== before) this.listScroll.scroll_to_item(after);
      cx.notify();
    });
  }

  spaceChoices(allSpaces, allPanes) {
    return groupSpaceOptions(allSpaces, spaceLocations(allSpaces, allPanes), this.repoByLocation);
  }

  options(row, key, allSpaces, allPanes, spaceChoices) {
    if (key === "command") return saved().map(c => [c, c]);
    if (key === "space") return spaceChoices ?? this.spaceChoices(allSpaces, allPanes);
    if (key === "tab") return (allSpaces.find(s => s.id === row.space)?.tabs ?? []).map(tab => [tab.id, tab.name, `Tab ${tab.index}`]);
    return forTab(allPanes, row.tab).map(p => [p.terminal, `${p.program?.name || "Terminal"} · ${p.terminal}`, p.cwd]);
  }

  problem(r, ss, ps) {
    if (!r.command) return saved().length ? missing : "Save a command to add it to this target.";
    if (!saved().includes(r.command)) return "Command removed. Choose another command.";
    const space = ss.find(s => s.id === r.space);
    if (!space) return r.space ? "Space closed. Choose another space." : missing;
    if (!space.tabs.some(t => t.id === r.tab)) return r.tab ? "Tab closed. Choose another tab." : missing;
    const pp = forTab(ps, r.tab);
    if (!pp.length) return "This tab has no terminal.";
    const pane = pp.find(p => p.terminal === r.terminal);
    if (!pane) return r.terminal ? "Terminal closed. Choose another terminal." : missing;
    if ((pane.app ?? null) !== r.agent) return "The program changed. Select this target again.";
    if (r.agent) {
      const report = terminals().find(t => t.address === r.terminal)?.report;
      if (report?.app !== r.agent) return "Agent identity unavailable. Check the target.";
      const state = report.state === "idle" ? pane.status : report.state;
      if (state === "done") return `${agentLabel(r.agent)} reports done, not idle. Enter the command in the agent directly.`;
      if (state !== "idle") return `${agentLabel(r.agent)} reports ${state ?? "unknown"}. Sending requires idle.`;
    }
    if (!r.agent && r.command === "/restart") return "Select an idle agent for /restart.";
    if (this.rows.some(other => other !== r && other.terminal === r.terminal)) return "This terminal is already in the batch.";
    return "";
  }

  run(cx) {
    const batch = this.rows.filter(r => !r.sent);
    if (this.busy || checking() || !batch.length || batch.some(r => this.problem(r, spaces(), panes()))) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        await Promise.all(batch.map(async r => {
          r.result = "Checking terminal…";
          try {
            await dispatch({ ...r }, { hc, spaces, panes, terminals, delay: ms => cx.sleep(ms) });
            r.sent = true;
            r.result = r.agent ? `Sent to ${agentLabel(r.agent)}` : "Submitted";
          } catch (e) { r.result = String(e.message ?? e); }
          cx.notify();
        }));
      } finally { this.busy = false; cx.notify(); }
    });
  }

  matches(options) {
    const query = this.search.value().trim().toLowerCase();
    return query ? options.filter(([, label, detail]) =>
      label.toLowerCase().includes(query) || detail?.toLowerCase().includes(query)) : options;
  }

  acceptMatch(cx) {
    if (!this.dropdown) return;
    const { row, key, active } = this.dropdown;
    const options = this.options(row, key, spaces(), panes());
    const matches = this.matches(options);
    const match = matches.find(([value]) => value === active) ?? matches[0];
    if (match) this.selectMatch(row, key, match[0], options.length, cx);
  }

  selectMatch(row, key, value, count, cx) {
    this.choose(row, key, value);
    this.dropdown = null;
    (key === "terminal" && count === 1 ? row.focus.tab : row.focus[key]).focus();
    cx.notify();
  }

  openMenu(row, key, options, first, cx) {
    this.search.set_value("");
    const menu = { row, key, active: options[first][0] };
    this.dropdown = menu;
    this.listScroll.scroll_to_item(first);
    if (key === "space") this.refreshSpaceRepos(cx);
    // Select focuses the popup first. Give typing to the input once it mounts.
    cx.timer.after(0, () => { if (this.dropdown === menu) this.search.focus(); });
  }

  field(r, key, options, t) {
    const id = `${key}-${r.id}`, focus = r.focus[key];
    const selected = options.findIndex(([value]) => value === r[key]);
    const [, label, detail, parent] = options[selected] ?? [];
    const text = parent ? `${parent} › ${label}` : label ?? `Choose ${fields[key].toLowerCase()}`;
    const disabled = this.busy || !options.length;
    const open = this.dropdown?.row === r && this.dropdown.key === key;
    const setOpen = (next, cx) => {
      if (next) {
        if (disabled) return;
        this.openMenu(r, key, options, Math.max(0, selected), cx);
      } else {
        if (this.dropdown?.row !== r || this.dropdown.key !== key) return;
        this.dropdown = null;
      }
      cx.notify();
    };
    const dismiss = cx => {
      setOpen(false, cx);
      focus.focus();
    };
    const trigger = h_flex().id(`${id}-trigger`).min_w(0).h(32).px(9).gap(6).items_center().rounded(5)
      .child(div().flex_1().min_w(0).truncate().text_color(label ? t.foreground : t.muted)
        .when(key === "command" && label, el => el.font_family(mono()).text_size(12)).child(text))
      .child(icon("chevron-down", 12).text_color(open ? t.accent : t.muted))
      .tooltip(detail || text)
      .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover))
        // The popup's outside-press handler runs in capture. Toggle from the
        // rendered state on the same press, not from a click after it redraws.
        .on_mouse_down("left", (_, cx) => {
          setOpen(!open, cx);
          (open ? focus : this.listFocus).focus();
          cx.stop_propagation();
        }));
    return div().flex_1().min_w(0)
      .child(div().id(`${id}-frame`).rounded(6).border_1().border_color(open || focus.is_focused() ? t.accent : t.input)
        .bg(disabled ? t.surface : t.background)
        .on_key_down((e, cx) => {
          if (open || e.keystroke !== "space") return;
          setOpen(true, cx);
          this.listFocus.focus();
          cx.stop_propagation();
        })
        .child(Select.new(id).accessibility_label(`${fields[key]}: ${text}`).disabled(disabled)
          .open(open).track_focus(focus).content_focus_handle(this.listFocus).on_open_change(setOpen)
          .child(Popup.new(`${id}-popup`, trigger).anchor("top_left")
            .when(open, el => el.content(this.fieldMenu(r, key, id, options, dismiss, t))))));
  }

  fieldMenu(r, key, id, choices, dismiss, t) {
    const options = this.matches(choices);
    const active = Math.max(0, options.findIndex(([value]) => value === this.dropdown.active));
    const moveFocus = (cx, forward) => {
      dismiss(cx);
      if (forward) window.focus_next(); else window.focus_prev();
      cx.stop_propagation();
    };
    const moveMatch = (cx, delta) => {
      if (options.length) {
        const next = Math.max(0, Math.min(options.length - 1, active + delta));
        this.dropdown.active = options[next][0];
        this.listScroll.scroll_to_item(next);
        cx.notify();
      }
      cx.stop_propagation();
    };
    const itemHeight = key === "command" ? 30 : 42;
    const { width, height } = window.viewport_size();
    return v_flex().id(`${id}-menu`).w(Math.min(360, Math.max(1, width - 16)))
      .track_focus(this.listFocus).key_context(menuContext)
      .border_1().border_color(t.input).rounded(7).bg(t.popover).shadow_lg()
      .on_mouse_down_out((_, cx) => dismiss(cx))
      .on_scroll_wheel((_, cx) => cx.stop_propagation())
      .on_action("command-runner.next-field", (_, cx) => moveFocus(cx, true))
      .on_action("command-runner.previous-field", (_, cx) => moveFocus(cx, false))
      .on_action("command-runner.next-match", (_, cx) => moveMatch(cx, 1))
      .on_action("command-runner.previous-match", (_, cx) => moveMatch(cx, -1))
      .on_action("command-runner.accept-match", (_, cx) => { this.acceptMatch(cx); cx.stop_propagation(); })
      .on_action("command-runner.dismiss-search", (_, cx) => { dismiss(cx); cx.stop_propagation(); })
      .child(h_flex().px(11).gap(8).items_center().border_b(1).border_color(t.input)
        .child(icon("search").text_color(t.muted))
        .child(Input.new(this.search).flex_1().min_w(0).h(36).text_color(t.foreground)
          .accessibility_label(`Search ${fields[key].toLowerCase()}`)))
      .child(v_flex().id(`${id}-options`).role("list_box").accessibility_label(fields[key])
        .p(4).h(Math.min(218, Math.max(1, height - 50), itemHeight * Math.max(1, options.length) + 8))
        .track_scroll(this.listScroll).overflow_y_scrollbar()
        .when(!options.length, el => el.child(div().px(8).py(5).text_color(t.muted).child("No matches.")))
        .children(options.map(([value, label, detail, parent], i) => {
          const description = detail ? `${label} · ${detail}` : label;
          return h_flex().id(`${id}-option-${value}`).role("list_box_option").aria_selected(value === r[key])
            .accessibility_label(description).set_position(i + 1, options.length)
            .h(itemHeight).flex_none().min_w(0).px(8).gap(8).items_center().rounded(4)
            .when(i === active, el => el.aria_active_descendant().bg(t.selected))
            .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(description)
            .on_click((_, cx) => this.selectMatch(r, key, value, choices.length, cx))
            .when(Boolean(parent), el => el.pl(22)
              .child(icon("branch", 13).text_color(t.muted)))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().when(key === "space" && !parent, el => el.font_semibold())
                .when(key === "command", el => el.font_family(mono()).text_size(12)).child(label))
              .when(detail, el => el.child(div().truncate().text_size(11).text_color(t.muted).child(detail))))
            .when(value === r[key], el => el.child(icon("check").text_color(t.accent)));
        })));
  }

  target(r, ss, ps, spaceChoices, problem, t) {
    const pp = this.options(r, "terminal", ss, ps);
    const route = r.agent ? `Send to ${agentLabel(r.agent)}` : "Run in shell";
    const message = r.result || (problem === missing ? "" : problem || route);
    const error = r.result ? r.result !== "Checking terminal…" : problem && problem !== missing;
    const color = r.sent ? t.done : error ? t.blocked : t.muted;
    return v_flex().flex_none().gap(6)
      .child(h_flex().items_center().gap(8)
        .children(["command", "space", "tab"].map(key => this.field(r, key, this.options(r, key, ss, ps, spaceChoices), t)))
        .child(button(`remove-${r.id}`, "", () => {
          this.rows = this.rows.filter(other => other !== r);
          for (const handle of Object.values(r.focus)) handle.release();
        }, { disabled: this.busy || this.rows.length === 1, glyph: "x", label: "Remove target" })))
      .when(pp.length > 1 || (pp.length === 1 && pp[0][0] !== r.terminal)
        || (this.dropdown?.row === r && this.dropdown.key === "terminal"), el => el.child(h_flex().items_center().gap(8)
          .child(div().text_color(t.muted).text_size(12).child("Terminal")).child(this.field(r, "terminal", pp, t))))
      .when(Boolean(message), el => el.child(div().text_size(12).text_color(color).child(message)));
  }

  render() {
    const t = theme(), ss = spaces(), ps = panes();
    const root = v_flex().id("command-runner").track_focus(this.formFocus)
      .size_full().bg(t.surface).text_color(t.foreground).text_size(13);
    const header = (glyph, title, subtitle, action) => h_flex().flex_none().px(18).py(13).gap(10)
      .items_center().border_b(1).border_color(t.border)
      .child(h_flex().size(34).flex_none().items_center().justify_center().rounded(7).bg(t.raised).child(icon(glyph, 18)))
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().font_semibold().text_size(17).child(title))
        .child(div().text_size(12).text_color(t.muted).child(subtitle))).child(action);
    if (this.manage) {
      const cmds = saved(), text = this.input.value().trim();
      return root.child(header("layers", "Saved commands", "Shell commands and agent input.",
        button("back", "Back", () => { this.manage = false; }, { glyph: "chevron-left" })))
        .child(h_flex().flex_none().px(18).pt(14).pb(8).gap(8).items_center()
          .child(Input.new(this.input).accessibility_label("New command or agent input").flex_1().min_w(0)
            .h(34).px(10).rounded(6).border_1().border_color(t.input).bg(t.background).font_family(mono())
            .focus(s => s.border_color(t.accent)))
          .child(button("save", "Save command", () => this.save(), { primary: true, disabled: !text || /[\x00-\x1f\x7f]/.test(text) || cmds.includes(text) })))
        .child(v_flex().id("saved").flex_1().min_h(0).overflow_y_scrollbar().px(18).pb(12).children(cmds.map(c => h_flex().flex_none().min_w(0).h(40).gap(8)
          .items_center().border_b(1).border_color(t.border).child(icon("terminal").text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(12).tooltip(c).child(c))
          .child(button(`delete-${c}`, "Remove", () => {
            setShared(KEY, saved().filter(cmd => cmd !== c));
            for (const r of this.rows) if (r.command === c) this.choose(r, "command", "");
          }, { label: `Remove ${c}` }))))
          .when(!cmds.length, el => el.child(div().py(10).text_color(t.muted).child("Save your first command above."))));
    }
    const choices = this.spaceChoices(ss, ps);
    const issues = this.rows.map(r => this.problem(r, ss, ps));
    const pending = this.rows.filter(r => !r.sent).length;
    const ready = this.rows.filter((r, i) => !r.sent && !issues[i]).length;
    return root.child(header("terminal", "Run commands", "Send commands without switching tabs.",
      button("manage", "Saved commands", () => { this.manage = true; }, { glyph: "layers", disabled: this.busy })))
      .child(h_flex().flex_none().px(18).pt(14).pb(6).gap(8).text_size(12).text_color(t.muted)
        .children(["Command", "Space", "Tab"].map(label => div().flex_1().min_w(0).font_medium().child(label)))
        .child(div().w(30).flex_none()))
      .child(v_flex().flex_1().min_h(0).px(18).pb(8).gap(6)
        .child(v_flex().id("targets").min_h(0).gap(8).overflow_y_scrollbar()
          .children(this.rows.map((r, i) => this.target(r, ss, ps, choices, issues[i], t))))
        .child(h_flex().flex_none().child(button("add", "Add target", cx => this.rows.push(this.newRow(this.rows[this.rows.length - 1].command, cx)), { glyph: "plus", disabled: this.busy }))))
      .child(h_flex().flex_none().px(18).py(10).gap(8).items_center().bg(t.chrome).border_t(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().font_medium().child(pending ? `${ready} of ${pending} ready` : "Batch submitted"))
          .child(div().text_size(11).text_color(t.muted).child("Agents receive text. Only known dev servers get Ctrl+C.")))
        .child(button("close", "Close", () => closeOverlay(props().overlay), { disabled: this.busy }))
        .child(button("run", this.busy ? "Running…" : `Run${pending > 1 ? ` ${pending} targets` : ""}`, cx => this.run(cx), {
          primary: true, disabled: this.busy || !pending || ready !== pending,
        })));
  }
}
