export const SESSION_LABEL = "omp.resume";
export const ATTEMPT_LABEL = "omp.resume.attempt";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const absolute = value => typeof value === "string" && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value) && !/[\x00-\x1f]/.test(value);
const shellName = name => String(name).split(/[\\/]/).pop().toLowerCase();
const shells = new Set(["pwsh.exe", "powershell.exe", "cmd.exe", "bash", "zsh", "fish", "sh", "nu"]);

function validIdentity(record) {
  return record && UUID.test(record.sessionId) && absolute(record.sessionFile) && absolute(record.cwd)
    && (record.profile == null || typeof record.profile === "string" && !/[\x00-\x1f]/.test(record.profile));
}

export function labelIdentity(terminal) {
  try {
    const record = JSON.parse(terminal.labels?.[SESSION_LABEL] ?? "null");
    return validIdentity(record) ? record : null;
  } catch {
    return null;
  }
}

function commandFor(record) {
  const file = record.sessionFile;
  const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const directory = file.slice(0, separator === 2 && file[1] === ":" ? 3 : separator) || "/";
  return ["omp", ...(record.profile ? ["--profile", record.profile] : []),
    "--session-dir", directory, "--resume", record.sessionId];
}

function entry(record) {
  if (!validIdentity(record) || typeof record.terminal !== "string" || record.terminal.includes("/")
    || !["pane", "space", "tab"].every(key => typeof record[key] === "string" && record[key])
    || !Number.isSafeInteger(record.createdMs) || !Number.isSafeInteger(record.rootPid)) {
    throw new Error("Invalid omp-sessions.json entry; file left untouched");
  }
  const result = {
    terminal: record.terminal, pane: record.pane, space: record.space, tab: record.tab,
    spaceName: record.spaceName ?? "", tabName: record.tabName ?? "",
    cwd: record.cwd, sessionId: record.sessionId, sessionFile: record.sessionFile,
    profile: record.profile ?? null, command: commandFor(record),
    rootPid: record.rootPid, createdMs: record.createdMs,
  };
  return result;
}

export function decodeRegistry(text) {
  if (text === null) return { version: 2, sessions: [] };
  const data = JSON.parse(text);
  if (![1, 2].includes(data?.version) || !Array.isArray(data.sessions)) {
    throw new Error("Invalid omp-sessions.json; file left untouched");
  }
  const records = data.version === 1
    ? data.sessions.filter(r => r?.sessionId && !["closed", "ended", "switched"].includes(r.status))
    : data.sessions;
  const sessions = records.map(record => {
    const result = entry(record);
    if (data.version === 2 && JSON.stringify(record.command) !== JSON.stringify(result.command)) {
      throw new Error("Invalid stored OMP command; file left untouched");
    }
    return result;
  });
  if (new Set(sessions.map(r => r.terminal)).size !== sessions.length) {
    throw new Error("Duplicate terminals in omp-sessions.json; file left untouched");
  }
  return { version: 2, sessions };
}

export function reconcileRegistry(registry, snapshot) {
  const terminals = new Map(snapshot.terminals.map(t => [t.address, t]));
  const agents = new Set(snapshot.agents.filter(a => a.app === "omp" && a.pane).map(a => a.address));
  const previous = new Map(registry.sessions.map(r => [r.terminal, r]));
  const sessions = [];
  for (const pane of snapshot.panes) {
    if (!pane.terminal || pane.terminal.includes("/")) continue;
    const terminal = terminals.get(pane.terminal);
    if (!terminal || terminal.state !== "live") continue;
    const candidate = previous.get(pane.terminal);
    const saved = candidate?.createdMs === terminal.created_ms ? candidate : null;
    if (snapshot.agents.some(a => a.address === pane.terminal && a.app && a.app !== "omp")) continue;
    const foreground = terminal.foreground;
    const identity = labelIdentity(terminal);
    const running = Boolean(terminal.pid) && (agents.has(pane.terminal)
      || /(?:^|[\\/])omp(?:\.exe)?$/i.test(foreground?.name ?? ""));
    const recovering = saved && terminal.keep && (!terminal.pid || !foreground
      || terminal.pid !== saved.rootPid && foreground.pid === terminal.pid
        && !terminal.reported && shells.has(shellName(foreground.name)));
    if (!running && !recovering) continue;
    const source = running && identity ? identity : saved;
    if (!source) continue;
    const space = snapshot.spaces.find(s => s.tabs.some(t => t.id === pane.tab));
    if (!space || space.machine != null) continue;
    const tab = space.tabs.find(t => t.id === pane.tab);
    sessions.push(entry({
      ...source, terminal: pane.terminal, pane: pane.pane, space: space.id, tab: pane.tab,
      spaceName: space.name, tabName: tab.name, createdMs: terminal.created_ms,
      rootPid: running ? terminal.pid : saved.rootPid,
    }));
  }
  return { version: 2, sessions };
}

export function resumeReason(record, terminal, pane) {
  if (!terminal || !pane || pane.pane !== record.pane || pane.tab !== record.tab
    || terminal.state !== "live" || !terminal.keep || terminal.created_ms !== record.createdMs
    || terminal.labels?.["herdr.space"] !== record.space || terminal.labels?.["herdr.tab"] !== record.tab) return "pane closed or changed";
  if (!terminal.pid || !terminal.foreground) return "pending";
  if (terminal.pid === record.rootPid) return "original terminal still running";
  if (terminal.foreground.pid !== terminal.pid || terminal.reported) return "another program is running";
  if (!["pwsh.exe", "powershell.exe"].includes(shellName(terminal.foreground.name))) return "not a PowerShell recovery shell";
  if (terminal.labels?.[ATTEMPT_LABEL] === `${terminal.pid}:${record.sessionId}`) return "resume already attempted";
  return null;
}

// PowerShell treats curly quote characters as quotes too (upstream Revive).
const psQuote = value => `'${String(value).replace(/['‘’‚‛]/g, "$&$&")}'`;
export function resumeCommand(record) {
  return `Set-Location -LiteralPath ${psQuote(record.cwd)} -ErrorAction Stop; & ${record.command.map(psQuote).join(" ")}`;
}
