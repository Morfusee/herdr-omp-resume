import assert from "node:assert/strict";
import {
  ATTEMPT_LABEL,
  SESSION_LABEL,
  decodeRegistry,
  reconcileRegistry,
  resumeCommand,
  resumeReason,
} from "../mods/omp-resume/registry.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const identity = {
  sessionId,
  sessionFile: `C:/sessions/${sessionId}.jsonl`,
  cwd: "C:/project",
  profile: null,
};
const pane = { terminal: "t1", pane: "p1", tab: "tab1" };
const agent = { address: "t1", pane: "p1", app: "omp" };
const terminal = {
  address: "t1",
  created_ms: 10,
  pid: 100,
  keep: true,
  state: "live",
  reported: true,
  labels: {
    "herdr.space": "space1",
    "herdr.tab": "tab1",
    [SESSION_LABEL]: JSON.stringify(identity),
  },
  foreground: { pid: 200, name: "omp.exe", cwd: "C:/project" },
};
const state = {
  terminals: [terminal],
  panes: [pane],
  agents: [agent],
  spaces: [{ id: "space1", name: "Project", machine: null, tabs: [{ id: "tab1", name: "omp" }] }],
};
const empty = decodeRegistry(null);
const registered = reconcileRegistry(empty, state);
assert.deepEqual(registered.sessions[0].command, [
  "omp",
  "--session-dir",
  "C:/sessions",
  "--resume",
  sessionId,
]);
assert.equal(registered.sessions[0].spaceName, "Project");
assert.equal(empty.sessions.length, 0, "reconciliation must not mutate its input");
assert.deepEqual(decodeRegistry(JSON.stringify(registered)), registered);

// Once recorded, a session needs no writer lease, file handle or process lookup.
let current = registered;
for (const pid of [201, 202, 203]) {
  const restarted = {
    ...terminal,
    labels: { "herdr.space": "space1", "herdr.tab": "tab1" },
    foreground: { ...terminal.foreground, pid },
  };
  current = reconcileRegistry(current, { ...state, terminals: [restarted] });
  assert.deepEqual(
    current,
    registered,
    "idle /restart must preserve the exact saved command and ID",
  );
}
const switchedIdentity = {
  ...identity,
  sessionId: secondId,
  sessionFile: `C:/sessions/${secondId}.jsonl`,
};
const switched = reconcileRegistry(current, {
  ...state,
  terminals: [
    {
      ...terminal,
      labels: { ...terminal.labels, [SESSION_LABEL]: JSON.stringify(switchedIdentity) },
    },
  ],
});
assert.deepEqual(
  switched.sessions.map((r) => r.sessionId),
  [secondId],
  "a session switch replaces the entry, not appends history",
);
assert.ok(!("status" in switched.sessions[0]));
assert.ok(!("ownershipVerified" in switched.sessions[0]));
assert.deepEqual(
  reconcileRegistry(switched, { ...state, panes: [], agents: [] }).sessions,
  [],
  "closing a pane removes its entry",
);
assert.deepEqual(
  reconcileRegistry(switched, { ...state, spaces: [] }).sessions,
  [],
  "closing a space removes its entries",
);
assert.deepEqual(
  reconcileRegistry(switched, { ...state, agents: [{ ...agent, app: "claude-code" }] }).sessions,
  [],
);

const shell = {
  ...terminal,
  reported: false,
  foreground: { pid: 100, name: "pwsh.exe", cwd: identity.cwd },
};
assert.deepEqual(
  reconcileRegistry(registered, { ...state, terminals: [shell], agents: [] }).sessions,
  [],
  "/exit removes a session even if its shell pane remains",
);
assert.deepEqual(
  reconcileRegistry(empty, { ...state, terminals: [shell], agents: [] }).sessions,
  [],
  "stale labels must not resurrect an exited agent",
);
const otherProgram = { ...terminal, foreground: { pid: 400, name: "vim.exe", cwd: identity.cwd } };
assert.deepEqual(
  reconcileRegistry(registered, { ...state, terminals: [otherProgram], agents: [] }).sessions,
  [],
  "a non-agent program in the pane must not retain an inactive OMP entry",
);
const unregistered = { ...terminal, labels: { "herdr.space": "space1", "herdr.tab": "tab1" } };
assert.deepEqual(
  reconcileRegistry(empty, { ...state, terminals: [unregistered] }).sessions,
  [],
  "never invent an ID for an agent without a hook event",
);
const reused = { ...unregistered, created_ms: 99 };
assert.deepEqual(
  reconcileRegistry(registered, { ...state, terminals: [reused] }).sessions,
  [],
  "terminal address reuse must not inherit an old conversation",
);
const invalidLabel = {
  ...terminal,
  labels: { ...terminal.labels, [SESSION_LABEL]: "broken json" },
};
assert.deepEqual(
  reconcileRegistry(registered, { ...state, terminals: [invalidLabel] }),
  registered,
  "bad new metadata must not erase a valid saved command",
);

// Migration keeps resumable active records only; there is no closed-session ledger.
const legacy = { ...registered.sessions[0], status: "untracked" };
delete legacy.command;
const migrated = decodeRegistry(
  JSON.stringify({
    version: 1,
    sessions: [
      legacy,
      { ...legacy, status: "closed", sessionId: secondId },
      { terminal: "t2", sessionId: null, status: "untracked" },
    ],
  }),
);
assert.deepEqual(migrated, registered);
assert.throws(() => decodeRegistry("broken json"));
assert.throws(() => decodeRegistry('{"version":2,"sessions":[{}]}'));
assert.throws(
  () =>
    decodeRegistry(
      JSON.stringify({
        version: 2,
        sessions: [
          { ...registered.sessions[0], command: ["omp", "--auto-approve", "--resume", sessionId] },
        ],
      }),
    ),
  "never execute an arbitrary command supplied through the JSON file",
);

const saved = registered.sessions[0];
const recovered = { ...shell, pid: 300, foreground: { ...shell.foreground, pid: 300 } };
assert.equal(resumeReason(saved, recovered, pane), null);
assert.equal(resumeReason(saved, terminal, pane), "original terminal still running");
assert.notEqual(resumeReason(saved, recovered, null), null, "closed panes must never reopen");
assert.notEqual(resumeReason(saved, { ...recovered, created_ms: 99 }, pane), null);
assert.notEqual(
  resumeReason(saved, { ...recovered, foreground: { ...recovered.foreground, pid: 400 } }, pane),
  null,
  "do not type into a busy recovery terminal",
);
assert.notEqual(resumeReason(saved, { ...recovered, reported: true }, pane), null);
assert.notEqual(
  resumeReason(
    saved,
    { ...recovered, labels: { ...recovered.labels, [ATTEMPT_LABEL]: `300:${sessionId}` } },
    pane,
  ),
  null,
  "a reload must not send the same resume twice",
);
assert.deepEqual(
  reconcileRegistry(registered, { ...state, terminals: [recovered], agents: [] }),
  registered,
  "a retained recovery pane keeps its resume entry until startup recovery",
);
const pendingRecovery = { ...recovered, pid: null, foreground: null };
assert.deepEqual(
  reconcileRegistry(registered, { ...state, terminals: [pendingRecovery], agents: [] }),
  registered,
  "waiting for a kept terminal's replacement shell must not erase its command",
);
assert.ok(resumeCommand(saved).includes(`'--resume' '${sessionId}'`));
assert.ok(!resumeCommand(saved).includes("--restore"));
assert.ok(resumeCommand({ ...saved, cwd: "C:/it's a project" }).includes("'C:/it''s a project'"));
assert.ok(resumeCommand({ ...saved, cwd: "C:/it’s a project" }).includes("'C:/it’’s a project'"));
console.log("Herdr active OMP registry checks passed");
