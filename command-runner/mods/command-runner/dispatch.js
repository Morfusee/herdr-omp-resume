const POSIX_SHELLS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const HC_PWSH_PROMPT = "$global:__hc_prompt = $function:prompt; function global:prompt { $p = & $global:__hc_prompt; $l = $ExecutionContext.SessionState.Path.CurrentLocation; if ($l.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {} }; $p }";

function executable(path) {
  return typeof path === "string" ? path.split(/[/\\]/u).pop().toLowerCase().replace(/^-|\.exe$/gu, "") : "";
}

function sameArgs(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((arg, i) => arg === b[i]);
}

function shellName(argv) {
  const [program, ...args] = argv;
  const name = executable(program);
  if (name === "pwsh" || name === "powershell") {
    if (args.length === 3 && args[0] === "-NoExit" && args[1] === "-Command" && args[2] === HC_PWSH_PROMPT) return name;
    if (args.every(arg => /^-(?:nologo|noprofile|noexit)$/iu.test(arg))) return name;
  }
  if (POSIX_SHELLS.has(name) && args.every(arg => /^-(?:[il]{1,2}|-login|-interactive)$/u.test(arg))) return name;
  if (name === "cmd" && args.every(arg => /^\/[dq]$/iu.test(arg))) return name;
  return null;
}

function originalShell(terminal, shell) {
  const fg = terminal.foreground;
  return fg.pid === terminal.pid && executable(fg.name) === shell
    && executable(fg.argv[0]) === shell && sameArgs(fg.argv.slice(1), terminal.argv.slice(1));
}

function devServer({ argv: [program, ...args] }) {
  const name = executable(program);
  if (/^python(?:3(?:\.\d+)?)?$/u.test(name)) {
    const offset = args[0] === "-u" ? 1 : 0;
    return args[offset] === "-m" && args[offset + 1] === "http.server";
  }
  if (name === "next") return args[0] === "dev";
  // The script name (e.g. `pnpm dev`) alone says nothing about its children.
  return name === "node" && /[/\\]node_modules[/\\]next[/\\]dist[/\\]bin[/\\]next$/u.test(args[0] ?? "") && args[1] === "dev";
}

function cleanPrompt(text, shell, cwd) {
  const end = text.trimEnd();
  const line = end.slice(end.lastIndexOf("\n") + 1);
  if (shell === "cmd" || shell === "pwsh" || shell === "powershell") {
    if (typeof cwd !== "string" || !cwd) return false;
    const expected = `${shell === "cmd" ? "" : "PS "}${cwd}>`;
    const normalize = value => value.replace(/\\/gu, "/").toLowerCase();
    return /^[a-z]:[/\\]|^\\\\/iu.test(cwd) ? normalize(line) === normalize(expected) : line === expected;
  }
  if (shell === "fish") return /^[\w.-]+@[\w.-]+ (?:~|\/)[^>]*>$/u.test(line);
  if (shell === "zsh" && /^[\w.-]+%$/u.test(line)) return true;
  return /^(?:[\w.-]+@[\w.-]+(?::[^\s]+)?|(?:ba|z|da|k)?sh-[\d.]+)?[$#]$/u.test(line);
}

async function invoke(hc, args) {
  const command = `hc ${args[0]}`;
  let result;
  try {
    result = await hc(args);
  } catch (error) {
    throw new Error(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code !== 0) throw new Error(`${command}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  try {
    const reply = JSON.parse(result.stdout);
    if (reply && typeof reply === "object" && !Array.isArray(reply) && !reply.error) return reply;
  } catch {
    // A missing reply does not make it safe to repeat a write.
  }
  throw new Error(`${command}: invalid reply`);
}

function sameLaunch(a, b) {
  return a.pid === b.pid && a.created_ms === b.created_ms && sameArgs(a.argv, b.argv);
}

export async function dispatch({ space, tab, terminal, command }, { hc, spaces, panes, terminals, delay }) {
  if (![space, tab, terminal].every(id => typeof id === "string" && id.trim())) throw new Error("Select a space, tab, and terminal.");
  if (typeof command !== "string" || !command.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(command)) {
    throw new Error("Use a nonblank, single-line command without control characters.");
  }

  function target() {
    const selected = spaces().find(item => item.id === space);
    if (!selected?.tabs.some(item => item.id === tab)) throw new Error("The selected space or tab is no longer available.");
    const prefix = selected.machine === null ? "" : `${selected.machine}/`;
    if (![space, tab, terminal].every(id => id.startsWith(prefix) && !id.slice(prefix.length).includes("/"))
      || !/^t[0-9a-z]+$/u.test(terminal.slice(prefix.length))) throw new Error("The target has an invalid machine address.");
    const matches = panes().filter(item => item.terminal === terminal);
    if (matches.length !== 1 || matches[0].tab !== tab || !matches[0].pane) {
      throw new Error("The selected terminal is no longer in that tab.");
    }
    const [pane] = matches;
    const live = terminals().find(item => item.address === terminal);
    if (live?.state !== "live" || !Number.isSafeInteger(live.pid) || live.pid <= 0
      || !Number.isSafeInteger(live.created_ms) || !Array.isArray(live.argv)) throw new Error("The selected terminal is no longer live.");
    if (pane.app != null || pane.status != null || live.status != null || live.reported === true || live.template != null) {
      throw new Error("The selected terminal belongs to an agent.");
    }
    return { pane: pane.pane, prefix, live };
  }

  const original = target();
  const shell = shellName(original.live.argv);
  if (!shell) throw new Error("The terminal was not launched as a supported interactive shell.");

  async function inspect() {
    const fresh = await invoke(hc, ["get", "--json", "--", terminal]);
    const current = target();
    const { prefix } = original;
    if (current.pane !== original.pane || current.prefix !== prefix
      || (fresh.address !== terminal && !(prefix && fresh.address === terminal.slice(prefix.length)))
      || fresh.labels?.["herdr.space"] !== space.slice(prefix.length)
      || fresh.labels?.["herdr.tab"] !== tab.slice(prefix.length)) throw new Error("The terminal's address or membership changed.");
    if (fresh.state !== "live" || !sameLaunch(original.live, current.live) || !sameLaunch(original.live, fresh)) {
      throw new Error("The original shell is no longer live.");
    }
    if (fresh.status != null || fresh.reported === true || fresh.template != null) throw new Error("The terminal belongs to an agent.");
    const fg = fresh.foreground;
    if (!Number.isSafeInteger(fg?.pid) || fg.pid <= 0 || !Array.isArray(fg.argv) || !fg.argv[0]) {
      throw new Error("The terminal's foreground process could not be identified.");
    }
    return fresh;
  }

  async function promptReady() {
    // A shell PID can also be running a builtin or waiting on an unfinished draft.
    const screen = await invoke(hc, ["read", "--json", "--lines", "0", "--", terminal]);
    const fresh = await inspect();
    if (!originalShell(fresh, shell)) throw new Error("The original shell is no longer in the foreground.");
    return screen.complete === true && screen.how === "screen" && typeof screen.text === "string"
      && cleanPrompt(screen.text, shell, fresh.foreground.cwd);
  }

  async function write(args) {
    const result = await invoke(hc, args);
    if (!Number.isSafeInteger(result.turn)) throw new Error(`hc ${args[0]} did not confirm delivery.`);
  }

  const send = () => write(["send", "--json", "--", terminal, command]);
  const fresh = await inspect();
  if (originalShell(fresh, shell)) {
    if (!await promptReady()) throw new Error("The shell does not show a clean prompt; check for a draft or interactive input.");
    return send();
  }
  const dev = fresh.foreground;
  if (dev.pid === fresh.pid || !devServer(dev)) throw new Error("The foreground process is not a recognized noninteractive dev server.");

  await write(["keys", "--json", "--", terminal, "ctrl+c"]);
  const deadline = Date.now() + 5000;
  for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt += 1) {
    await delay(250);
    const current = await inspect();
    if (originalShell(current, shell)) {
      if (await promptReady() && Date.now() < deadline) return send();
    } else if (current.foreground.pid !== dev.pid || !sameArgs(current.foreground.argv, dev.argv)) {
      throw new Error("The foreground changed to another process after Ctrl+C.");
    }
  }
  throw new Error("The original shell did not return to a clean prompt after Ctrl+C.");
}
