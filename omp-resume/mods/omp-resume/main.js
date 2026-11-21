import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  exec,
  hc,
  machines,
  notify,
  panes,
  readTextFile,
  setShared,
  shared,
  spaces,
  terminals,
  theme,
  writeTextFile,
} from "herdr";
import {
  ATTEMPT_LABEL,
  SESSION_LABEL,
  decodeRegistry,
  reconcileRegistry,
  resumeCommand,
  resumeReason,
} from "./registry.js";

function snapshot() {
  return { agents: agents(), panes: panes(), spaces: spaces(), terminals: terminals() };
}

function signature(state) {
  return JSON.stringify({
    panes: state.panes.map((p) => [p.pane, p.terminal, p.tab]),
    spaces: state.spaces.map((s) => [s.id, s.name, s.machine, s.tabs.map((t) => [t.id, t.name])]),
    agents: state.agents.map((a) => [a.address, a.app, a.pane]),
    terminals: state.terminals.map((t) => [
      t.address,
      t.pid,
      t.created_ms,
      t.state,
      t.reported,
      t.foreground?.pid,
      t.foreground?.name,
      t.labels?.[SESSION_LABEL],
      t.labels?.[ATTEMPT_LABEL],
    ]),
  });
}

export default class OmpResume extends View {
  init(props) {
    this.service = props?.service === true;
    this.error = null;
    this.busy = false;
    this.signature = null;
    this.startup = null;
    this.startupDeadline = Date.now() + 30000;
  }

  async restore(registry, cx) {
    if (this.startup === null) this.startup = new Set(registry.sessions.map((r) => r.terminal));
    for (const record of registry.sessions) {
      if (!this.startup.has(record.terminal)) continue;
      const current = snapshot();
      const terminal = current.terminals.find((t) => t.address === record.terminal);
      const pane = current.panes.find((p) => p.terminal === record.terminal);
      const reason = resumeReason(record, terminal, pane);
      if (reason === "pending" && Date.now() < this.startupDeadline) continue;
      this.startup.delete(record.terminal);
      if (reason !== null) continue;
      const other = registry.sessions.some(
        (r) =>
          r.terminal !== record.terminal &&
          r.sessionId === record.sessionId &&
          current.agents.some((a) => a.address === r.terminal && a.app === "omp"),
      );
      if (other) continue;
      const file = await exec("node", [
        "-e",
        "process.stdout.write(JSON.stringify(require('node:fs').existsSync(process.argv[1])))",
        record.sessionFile,
      ]);
      if (file.code !== 0) throw new Error(file.stderr);
      if (JSON.parse(file.stdout) !== true) {
        notify({
          title: "OMP registry",
          body: `No saved conversation yet for ${record.spaceName} / ${record.tabName}`,
          level: "warning",
        });
        continue;
      }
      const check = await hc(["get", record.terminal, "--json"]);
      if (check.code !== 0) throw new Error(check.stderr);
      const fresh = JSON.parse(check.stdout);
      if (
        fresh.pid !== terminal.pid ||
        resumeReason(
          record,
          fresh,
          panes().find((p) => p.terminal === record.terminal),
        ) !== null
      )
        continue;
      cx.notify();
      const reservation = await hc([
        "label",
        record.terminal,
        `${ATTEMPT_LABEL}=${fresh.pid}:${record.sessionId}`,
      ]);
      if (reservation.code !== 0) throw new Error(reservation.stderr);
      cx.notify();
      const sent = await hc(["send", record.terminal, resumeCommand(record), "--json"]);
      if (sent.code !== 0) throw new Error(sent.stderr);
    }
  }

  refresh(cx, nextSignature) {
    if (this.busy) return;
    this.busy = true;
    this.signature = nextSignature;
    cx.spawn(async (cx) => {
      try {
        const path = `${appHome()}/omp-sessions.json`;
        const text = await readTextFile(path);
        const saved = decodeRegistry(text);
        await this.restore(saved, cx);
        const current = snapshot();
        const registry = reconcileRegistry(saved, current);
        const next = JSON.stringify(registry, null, 2) + "\n";
        if (next !== text) await writeTextFile(path, next, text);
        if (shared("omp-resume.registered") !== registry.sessions.length)
          setShared("omp-resume.registered", registry.sessions.length);
        if (shared("omp-resume.error") !== null) setShared("omp-resume.error", null);
        this.error = null;
      } catch (error) {
        const message = String(error);
        if (this.error !== message)
          notify({ title: "OMP registry", body: message, level: "error" });
        this.error = message;
        if (shared("omp-resume.error") !== message) setShared("omp-resume.error", message);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    if (!checking() && machines().find((m) => m.name === null)?.layout === "ready") {
      const state = snapshot();
      const nextSignature = `${signature(state)}:${shared("omp-resume.refresh") ?? 0}`;
      if (nextSignature !== this.signature) this.refresh(cx, nextSignature);
    }
    if (this.service) return div().size_full();
    const t = theme();
    return h_flex()
      .size_full()
      .items_center()
      .px(14)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(shared("omp-resume.error") ? t.blocked : t.muted)
      .child(
        div()
          .id("omp-registered")
          .cursor_pointer()
          .on_click(() => setShared("omp-resume.refresh", Date.now()))
          .child(`${shared("omp-resume.registered") ?? 0} OMP Registered`),
      );
  }
}
