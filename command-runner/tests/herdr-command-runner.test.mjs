import assert from "node:assert/strict";
import test from "node:test";
import { dispatch } from "../mods/command-runner/dispatch.js";

const python = { pid: 43, name: "python.exe", argv: ["python.exe", "-m", "http.server", "--bind", "127.0.0.1", "0"] };
const quiet = { complete: true, how: "screen", text: "PS C:\\code> \n\n" };
const ok = data => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });

function fixture(machine = null) {
  const prefix = machine ? `${machine}/` : "";
  const row = { space: `${prefix}sp1`, tab: `${prefix}tb1`, terminal: `${prefix}t7`, command: "pnpm dev" };
  const live = {
    address: row.terminal, pid: 42, created_ms: 1234, state: "live",
    argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo"],
  };
  const shell = { pid: live.pid, name: "pwsh.exe", argv: live.argv, cwd: "C:\\code" };
  const fresh = { ...live, foreground: shell, labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } };
  const visible = [{ pane: `${prefix}p1`, tab: row.tab, terminal: row.terminal }];
  const space = { id: row.space, machine, tabs: [{ id: row.tab }] };
  const calls = [];
  const delays = [];
  const replies = {};
  const deps = {
    hc: async args => {
      calls.push(args);
      const overridden = replies[args[0]]?.();
      if (overridden) return overridden;
      if (args[0] === "get") return ok(fresh);
      if (args[0] === "read") return ok(quiet);
      return ok({ turn: 0 });
    },
    spaces: () => [space], panes: () => visible, terminals: () => [live],
    delay: async ms => { delays.push(ms); },
  };
  return { row, live, shell, fresh, visible, space, calls, delays, replies, deps };
}

function operations(fixture) {
  return fixture.calls.map(args => args[0]);
}

function writes(fixture) {
  return operations(fixture).filter(name => name === "keys" || name === "send");
}

test("submits the exact command once to a verified Windows shell", async () => {
  const f = fixture();
  f.row.command = '  --literal "argument with spaces"';
  await dispatch(f.row, f.deps);
  assert.deepEqual(f.calls, [
    ["get", "--json", "--", "t7"],
    ["read", "--json", "--lines", "0", "--", "t7"],
    ["get", "--json", "--", "t7"],
    ["send", "--json", "--", "t7", f.row.command],
  ]);
});

test("rejects malformed or ambiguous selections before touching the core", async () => {
  const f = fixture();
  await assert.rejects(dispatch({ ...f.row, command: "echo one\necho two" }, f.deps), /single-line/);
  await assert.rejects(dispatch({ ...f.row, tab: "tb2" }, f.deps), /space or tab/);
  await assert.rejects(dispatch({ ...f.row, terminal: "remote/t7" }, f.deps), /machine address/);
  f.visible.push({ ...f.visible[0], pane: "p2" });
  await assert.rejects(dispatch(f.row, f.deps), /no longer in that tab/);
  assert.deepEqual(f.calls, []);
});

test("keeps remote addresses qualified and compares labels on their own machine", async () => {
  const f = fixture("work");
  f.live.argv = f.fresh.argv = ["/bin/bash", "-l"];
  f.fresh.foreground = { pid: f.live.pid, name: "bash", argv: ["-bash", "-l"], cwd: "/code" };
  f.fresh.address = "t7";
  f.replies.read = () => ok({ ...quiet, text: "user@work:~/code$ " });
  await dispatch(f.row, f.deps);
  assert.ok(f.calls.every(args => args.includes("work/t7")));
  f.fresh.address = "other/t7";
  await assert.rejects(dispatch(f.row, f.deps), /address or membership changed/);
  assert.deepEqual(writes(f), ["send"]);
});

test("revalidates layout, live labels, and shell identity before submitting", async () => {
  for (const [change, error] of [
    [f => { f.space.tabs = []; }, /space or tab/],
    [f => { f.fresh.labels = { ...f.fresh.labels, "herdr.tab": "tb2" }; }, /membership changed/],
    [f => { f.fresh.pid += 1; }, /original shell is no longer live/],
    [f => { f.fresh.state = "finished"; }, /original shell is no longer live/],
    [f => { f.fresh.foreground = python; }, /no longer in the foreground/],
  ]) {
    const f = fixture();
    f.replies.read = () => { change(f); return ok(quiet); };
    await assert.rejects(dispatch(f.row, f.deps), error);
    assert.deepEqual(writes(f), []);
  }
});

test("leaves drafts, builtins, agents, editors, REPLs, and generic dev scripts alone", async () => {
  for (const text of ["PS C:\\code> unfinished", "PS C:\\code> Read-Host\nType a value: ", "PS C:\\code> a multiline draft\n>> "]) {
    const f = fixture();
    f.replies.read = () => ok({ ...quiet, text });
    await assert.rejects(dispatch(f.row, f.deps), /clean prompt/);
    assert.deepEqual(writes(f), []);
  }
  for (const argv of [
    ["lazygit.exe"], ["python.exe"], ["node.exe", "C:\\corepack\\pnpm.js", "dev:custom"],
    ["wsl.exe"], ["pwsh.exe"],
  ]) {
    const f = fixture();
    f.fresh.foreground = { pid: 43, name: argv[0], argv };
    await assert.rejects(dispatch(f.row, f.deps), /not a recognized noninteractive/);
    assert.deepEqual(writes(f), []);
  }
  const agent = fixture();
  agent.fresh.status = { app: "omp", state: "idle" };
  await assert.rejects(dispatch(agent.row, agent.deps), /agent/);
  assert.deepEqual(writes(agent), []);
  const scripted = fixture();
  scripted.live.argv.push("-Command", "Read-Host");
  await assert.rejects(dispatch(scripted.row, scripted.deps), /not launched as a supported interactive shell/);
  assert.deepEqual(scripted.calls, []);
});

test("interrupts one identifiable dev server and waits for the same clean root shell", async () => {
  const f = fixture();
  f.fresh.foreground = python;
  f.replies.keys = () => { f.fresh.foreground = f.shell; };
  let read = 0;
  f.replies.read = () => ok(read++ === 0 ? { ...quiet, text: "Keyboard interrupt received, exiting." } : quiet);
  await dispatch(f.row, f.deps);
  assert.deepEqual(operations(f), ["get", "keys", "get", "read", "get", "get", "read", "get", "send"]);
  assert.deepEqual(f.calls[1], ["keys", "--json", "--", "t7", "ctrl+c"]);
  assert.deepEqual(f.delays, [250, 250]);
});

test("does not escalate or submit when the interrupted dev server stays or changes", async () => {
  const timedOut = fixture();
  timedOut.fresh.foreground = python;
  await assert.rejects(dispatch(timedOut.row, timedOut.deps), /did not return/);
  assert.ok(timedOut.delays.length > 0 && timedOut.delays.length <= 20);
  assert.deepEqual(writes(timedOut), ["keys"]);

  const changed = fixture();
  changed.fresh.foreground = python;
  changed.replies.keys = () => { changed.fresh.foreground = { ...python, pid: 44 }; };
  await assert.rejects(dispatch(changed.row, changed.deps), /changed to another process/);
  assert.deepEqual(writes(changed), ["keys"]);
});

test("surfaces core failures or missing acknowledgments and never retries", async () => {
  const f = fixture();
  f.replies.send = () => ({ code: 11, stdout: "", stderr: '{"error":{"message":"terminal finished"}}' });
  await assert.rejects(dispatch(f.row, f.deps), /hc send:.*terminal finished/);
  assert.deepEqual(writes(f), ["send"]);

  const interrupted = fixture();
  interrupted.fresh.foreground = python;
  interrupted.replies.keys = () => ok({});
  await assert.rejects(dispatch(interrupted.row, interrupted.deps), /hc keys did not confirm delivery/);
  assert.deepEqual(writes(interrupted), ["keys"]);
});
