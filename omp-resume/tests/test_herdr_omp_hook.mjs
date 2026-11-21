import assert from "node:assert/strict";
import { createHerdrResume } from "../mods/omp-resume/omp/revive.ts";

const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";

// The check runs inside a nested omp shell; the hook's own environment must be blank.
delete process.env.OMPCODE;
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;
delete process.env.HC_TERMINAL_ID;

function fakePi() {
  const handlers = new Map();
  const warnings = [];
  return {
    warnings,
    on(event, handler) {
      handlers.set(event, handler);
    },
    logger: { warn: (message) => warnings.push(message) },
    emit(event, ctx) {
      handlers.get(event)?.({}, ctx);
    },
  };
}

function context({
  id = sessionA,
  file = `C:/sessions/${id}.jsonl`,
  cwd = "C:/project",
  hasUI = true,
  kind = "main",
} = {}) {
  return {
    hasUI,
    agent: { kind },
    cwd,
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => file,
    },
  };
}

function label(call) {
  assert.equal(call[0], "label");
  assert.equal(call[1], "t1");
  assert.ok(call[2].startsWith("omp.resume="), "the hook publishes exactly one label");
  return JSON.parse(call[2].slice("omp.resume=".length));
}

function install(pi, options = {}) {
  const calls = [];
  const hook = createHerdrResume({
    terminalId: "t1",
    argv: [],
    run: async (args) => {
      calls.push(args);
    },
    warn: (message) => pi.warnings.push(message),
    ...options,
  });
  hook.install(pi);
  return { hook, calls };
}

// Outside Herdr nothing is published.
{
  const pi = fakePi();
  const calls = [];
  const hook = createHerdrResume({
    argv: [],
    run: async (args) => {
      calls.push(args);
    },
  });
  hook.install(pi);
  pi.emit("session_start", context());
  await hook.flush();
  assert.equal(calls.length, 0, "without HC_TERMINAL_ID the hook publishes nothing");
}

// One-shot, RPC and subagent sessions never publish.
{
  const pi = fakePi();
  const { hook, calls } = install(pi);
  pi.emit("session_start", context({ hasUI: false }));
  pi.emit("agent_end", context({ kind: "sub" }));
  await hook.flush();
  assert.equal(calls.length, 0, "no-UI and subagent sessions are filtered");
}

// Explicit launch arguments refuse even when ctx.hasUI lies (rpc-ui has a UI).
for (const argv of [
  ["--print"],
  ["-p"],
  ["--no-session"],
  ["--mode", "json"],
  ["--mode=rpc"],
  ["--mode", "rpc-ui"],
]) {
  const pi = fakePi();
  const { hook, calls } = install(pi, { argv });
  pi.emit("session_start", context());
  await hook.flush();
  assert.equal(calls.length, 0, `refused launch: ${argv.join(" ")}`);
}

for (const argv of [["--mode", "text"], ["--mode=text"]]) {
  const pi = fakePi();
  const { hook, calls } = install(pi, { argv });
  pi.emit("session_start", context());
  await hook.flush();
  assert.equal(
    label(calls[0]).sessionId,
    sessionA,
    "explicit interactive text mode must still register",
  );
}

// A nested omp inherits OMPCODE=1 and must not report over its parent's terminal.
{
  process.env.OMPCODE = "1";
  const pi = fakePi();
  const { hook, calls } = install(pi);
  pi.emit("session_start", context());
  await hook.flush();
  assert.equal(calls.length, 0, "nested omp publishes nothing");
  delete process.env.OMPCODE;
}

// Real session changes publish the new identity with the full label payload.
{
  const pi = fakePi();
  const { hook, calls } = install(pi);
  pi.emit("session_start", context());
  pi.emit("session_switch", context({ id: sessionB, cwd: "C:/other" }));
  await hook.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(label(calls[0]), {
    sessionId: sessionA,
    sessionFile: `C:/sessions/${sessionA}.jsonl`,
    cwd: "C:/project",
    profile: null,
  });
  const switched = label(calls[1]);
  assert.equal(switched.sessionId, sessionB);
  assert.equal(switched.sessionFile, `C:/sessions/${sessionB}.jsonl`);
  assert.equal(switched.cwd, "C:/other");
}

// Repeating the same metadata, whatever the event, writes nothing new.
{
  const pi = fakePi();
  const { hook, calls } = install(pi);
  pi.emit("session_start", context());
  pi.emit("agent_end", context());
  pi.emit("turn_end", context());
  pi.emit("session_branch", context());
  pi.emit("session_tree", context());
  await hook.flush();
  assert.equal(calls.length, 1, "unchanged metadata is suppressed");
}

// agent_end/turn_end still publish a metadata change observed after the start.
{
  const pi = fakePi();
  const { hook, calls } = install(pi);
  pi.emit("session_start", context());
  pi.emit("agent_end", context({ cwd: "C:/moved" }));
  await hook.flush();
  assert.equal(calls.length, 2);
  assert.equal(label(calls[1]).cwd, "C:/moved");
}

// A new session without a file (--no-session) has nothing to resume.
{
  const pi = fakePi();
  const { hook, calls } = install(pi);
  const noSession = {
    ...context(),
    sessionManager: { getSessionId: () => sessionA, getSessionFile: () => undefined },
  };
  pi.emit("session_start", noSession);
  await hook.flush();
  assert.equal(calls.length, 0);
}

// Unsafe metadata is refused once instead of publishing a broken resume command.
{
  const pi = fakePi();
  const { hook, calls } = install(pi);
  const relative = {
    ...context(),
    sessionManager: { ...context().sessionManager, getSessionFile: () => "sessions/session.jsonl" },
  };
  pi.emit("session_start", relative);
  pi.emit("agent_end", relative);
  await hook.flush();
  assert.equal(calls.length, 0);
  assert.equal(pi.warnings.length, 1, "invalid metadata warns once");
}

// Explicit --profile wins, then OMP_PROFILE; the default profile is null.
{
  const first = fakePi();
  const explicit = install(first, { argv: ["--profile", "explicit-profile"] });
  first.emit("session_start", context());
  await explicit.hook.flush();
  assert.equal(label(explicit.calls[0]).profile, "explicit-profile");

  process.env.OMP_PROFILE = "env-profile";
  const second = fakePi();
  const env = install(second);
  second.emit("session_start", context());
  await env.hook.flush();
  assert.equal(label(env.calls[0]).profile, "env-profile");

  const third = fakePi();
  const both = install(third, { argv: ["--profile=explicit-profile"] });
  third.emit("session_start", context());
  await both.hook.flush();
  assert.equal(label(both.calls[0]).profile, "explicit-profile", "argv beats the environment");

  process.env.OMP_PROFILE = "default";
  const fourth = fakePi();
  const fallback = install(fourth);
  fourth.emit("session_start", context());
  await fallback.hook.flush();
  assert.equal(label(fallback.calls[0]).profile, null);
  delete process.env.OMP_PROFILE;
}

// Writes are serialized; a duplicate queued behind an in-flight write is dropped.
{
  const pi = fakePi();
  const { promise: gate, resolve } = Promise.withResolvers();
  const { promise: firstStarted, resolve: started } = Promise.withResolvers();
  const calls = [];
  const hook = createHerdrResume({
    terminalId: "t1",
    argv: [],
    run: async (args) => {
      calls.push(args);
      started();
      await gate;
    },
    warn: (message) => pi.warnings.push(message),
  });
  hook.install(pi);
  pi.emit("session_start", context());
  pi.emit("turn_end", context());
  pi.emit("session_switch", context({ id: sessionB }));
  await firstStarted;
  assert.equal(calls.length, 1, "one hc call at a time");
  resolve();
  await hook.flush();
  assert.equal(calls.length, 2, "the duplicate is dropped, the new session is not");
  assert.equal(label(calls[1]).sessionId, sessionB);
}

// A failed publish warns and does not latch the metadata forever.
{
  const pi = fakePi();
  let attempts = 0;
  const hook = createHerdrResume({
    terminalId: "t1",
    argv: [],
    run: async () => {
      attempts++;
      throw new Error("hc is not running");
    },
    warn: (message) => pi.warnings.push(message),
  });
  hook.install(pi);
  pi.emit("session_start", context());
  await hook.flush();
  assert.equal(attempts, 1);
  assert.match(pi.warnings[0], /omp\.resume/);
  assert.match(pi.warnings[0], /hc is not running/);
  pi.emit("agent_end", context());
  await hook.flush();
  assert.equal(attempts, 2, "a later event retries the withheld metadata");
}

console.log("Herdr omp resume hook checks passed");
