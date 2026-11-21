// Bundled with the Herdr omp-resume mod. Publishes this terminal's omp session
// identity as the `omp.resume` label, the only thing the mod reads to build a
// resume command. Adapted from RAF1337/herdr-revive-win's omp extension and
// lib/extension.js (MIT; see ../LICENSE), but self-contained: no local log, no
// helper process, and no registry writes. One hc label call per real change.
//
// Checked against omp 18.22.0: an interactive top-level session is
// `ctx.hasUI === true` and `ctx.agent.kind === "main"`. Print/JSON/RPC
// launches have no UI, subagents report "sub", and shells omp spawns carry
// OMPCODE=1, so a nested interactive omp is not mistaken for the pane's agent.
// rpc-ui may report a UI, so launch arguments are refused explicitly too.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL = "omp.resume";
const HC_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|\/|\\\\)/i;

// Session lifecycle events, never session_shutdown: the mod removes a session
// when its agent/pane closes, so /restart and a crashing core keep the label.
const EVENTS = ["session_start", "session_switch", "session_branch", "session_tree", "agent_end", "turn_end"];

type Run = (args: string[]) => Promise<void>;

interface PiApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
  logger?: { warn?: (message: string) => void };
}

interface Context {
  hasUI?: boolean;
  agent?: { kind?: string };
  cwd?: string;
  sessionManager?: {
    getSessionId?(): string;
    getSessionFile?(): string | undefined;
  };
}

interface Snapshot {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  profile: string | null;
}

const absolutePath = (value: unknown): value is string =>
  typeof value === "string" && ABSOLUTE.test(value) && !/[\x00-\x1f]/.test(value);

/** Headless/one-shot launches are not the pane's interactive agent. */
function nonInteractive(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") return false;
    if (arg === "--print" || arg === "-p" || arg === "--no-session") return true;
    const mode = arg === "--mode" ? argv[++index] : arg.startsWith("--mode=") ? arg.slice(7) : undefined;
    if (mode && mode !== "text") return true;
  }
  return false;
}

/** An explicit `--profile`/`--profile=` wins, then omp's exported OMP_PROFILE. */
function activeProfile(argv: readonly string[]): string | null {
  let explicit: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (value && !value.startsWith("-")) {
        explicit = value;
        index += 1;
      }
    } else if (arg.startsWith("--profile=")) {
      explicit = arg.slice("--profile=".length);
    }
  }
  const name = (explicit ?? process.env.OMP_PROFILE)?.trim();
  if (!name || name === "default" || name === "." || name === ".." || name.endsWith(".")) return null;
  return PROFILE.test(name) && !RESERVED.test(name) ? name : null;
}

function snapshot(ctx: Context, argv: readonly string[]): Snapshot | undefined {
  if (nonInteractive(argv)) return undefined;
  if (ctx.hasUI !== true || ctx.agent?.kind !== "main") return undefined;
  const manager = ctx.sessionManager;
  const sessionId = manager?.getSessionId?.();
  const sessionFile = manager?.getSessionFile?.();
  const cwd = ctx.cwd;
  // --no-session has no file; nothing a resume command could target.
  if (!sessionId || !sessionFile || !cwd) return undefined;
  if (!UUID.test(sessionId) || !absolutePath(sessionFile) || !absolutePath(cwd)) {
    throw new Error("session metadata is not a UUID, absolute file and absolute cwd");
  }
  return { sessionId, sessionFile, cwd, profile: activeProfile(argv) };
}

async function runHc(args: string[]): Promise<void> {
  await execFileAsync("hc", args, { timeout: HC_TIMEOUT_MS, windowsHide: true });
}

/**
 * The label publisher. `options` exists for the regression check; omp calls the
 * default export, which uses `HC_TERMINAL_ID`, real argv and the real hc.
 */
export function createHerdrResume(
  options: { terminalId?: string; argv?: readonly string[]; run?: Run; warn?: (message: string) => void } = {},
) {
  let queue = Promise.resolve();
  let lastQueued: string | undefined;
  let lastPublished: string | undefined;

  return {
    install(pi: PiApi): void {
      // Nested omp inherits OMPCODE=1 from the parent agent's shell.
      if (process.env.OMPCODE === "1") return;
      const terminalId = options.terminalId ?? process.env.HC_TERMINAL_ID;
      if (!terminalId) return;
      const argv = options.argv ?? process.argv.slice(2);

      const warned = new Set<string>();
      const warn = (message: string) => {
        if (options.warn) {
          try { options.warn(message); } catch {}
          return;
        }
        try {
          pi.logger?.warn?.(message);
          return;
        } catch {}
        try { console.warn(message); } catch {}
      };
      const warnOnce = (key: string, message: string) => {
        if (warned.has(key)) return;
        warned.add(key);
        warn(message);
      };

      const update = (ctx: unknown) => {
        let metadata: Snapshot | undefined;
        try {
          metadata = snapshot(ctx as Context, argv);
        } catch (error) {
          warnOnce(`invalid:${(error as Error).message}`,
            `herdr omp-resume: cannot publish ${LABEL} on ${terminalId}: ${(error as Error).message}`);
          return;
        }
        if (!metadata) return;

        const json = JSON.stringify(metadata);
        if (json === lastQueued) return;
        lastQueued = json;
        queue = queue.then(async () => {
          if (json === lastPublished) return;
          try {
            await (options.run ?? runHc)(["label", terminalId, `${LABEL}=${json}`]);
            lastPublished = json;
          } catch (error) {
            // Let the next lifecycle event retry the same metadata.
            if (lastQueued === json) lastQueued = undefined;
            const reason = error instanceof Error ? error.message : String(error);
            warn(`herdr omp-resume: cannot publish ${LABEL} on ${terminalId}: ${reason}`);
          }
        });
      };

      for (const event of EVENTS) pi.on(event, (_event, ctx) => update(ctx));
    },
    /** Settles after the writes scheduled so far, for the regression check. */
    flush: () => queue,
  };
}

export default function revive(pi: PiApi): void {
  createHerdrResume().install(pi);
}
