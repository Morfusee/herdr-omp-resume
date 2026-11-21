import assert from "node:assert/strict";
import test from "node:test";
import { groupSpaceOptions, readSpaceRepo, spaceLocations } from "../mods/command-runner/space-options.js";

test("nests interleaved worktrees under the first main without merging duplicate names", () => {
  const spaces = [
    { id: "a2", name: "review", folder: "/worktrees/a-second" },
    { id: "b", name: "Beta", folder: "/repos/b" },
    { id: "plain", name: "Scratch", folder: "/tmp" },
    { id: "a", name: "Alpha", folder: "/repos/a" },
    { id: "b1", name: "review", folder: "/worktrees/b-first" },
    { id: "another-a", name: "Another Alpha", folder: "/repos/a" },
    { id: "a1", name: "review", folder: "/worktrees/a-first" },
  ];
  const locations = spaceLocations(spaces, []);
  const repos = new Map([
    ["a", "A", false], ["b", "B", false], ["a2", "A", true], ["b1", "B", true], ["a1", "A", true],
  ].map(([id, repo, linked]) => [locations.get(id).key, { repo, linked }]));

  assert.deepEqual(groupSpaceOptions(spaces, locations, repos), [
    ["b", "Beta", "Local · /repos/b"],
    ["b1", "review", "Beta · Local · /worktrees/b-first", "Beta"],
    ["plain", "Scratch", "Local · /tmp"],
    ["a", "Alpha", "Local · /repos/a"],
    ["a2", "review", "Alpha · Local · /worktrees/a-second", "Alpha"],
    ["a1", "review", "Alpha · Local · /worktrees/a-first", "Alpha"],
    ["another-a", "Another Alpha", "Local · /repos/a"],
  ]);
});

test("keeps orphan worktrees and spaces with missing metadata selectable in place", () => {
  const spaces = [
    { id: "wt", name: "review", machine: "dev", folder: "/worktrees/review" },
    { id: "bad", name: "Unavailable", machine: "dev", folder: "/missing" },
    { id: "home", name: "Home" },
  ];
  const locations = spaceLocations(spaces, []);
  const repos = new Map([
    [locations.get("wt").key, { repo: "orphan", linked: true }],
    [locations.get("bad").key, null],
  ]);
  assert.deepEqual(groupSpaceOptions(spaces, locations, repos), [
    ["wt", "review", "dev · /worktrees/review"],
    ["bad", "Unavailable", "dev · /missing"],
    ["home", "Home", "Local · ~"],
  ]);
});

test("uses the first live pane by pane order and keys equivalent locations once per machine", () => {
  const spaces = [
    { id: "dev/sp1", name: "Work", machine: "dev", folder: "/original", tabs: [{ id: "dev/tab1" }, { id: "dev/tab2" }] },
    { id: "dev/sp2", name: "Copy", machine: "dev", folder: "/live" },
    { id: "sp1", name: "Local", folder: "/live", tabs: [{ id: "tab1" }] },
  ];
  const locations = spaceLocations(spaces, [
    { tab: "unrelated", cwd: "/another-space" },
    { tab: "dev/tab1", cwd: null },
    { tab: "dev/tab2", cwd: "/live" },
    { tab: "dev/tab1", cwd: "/later" },
  ]);
  assert.deepEqual([...locations.keys()], spaces.map(space => space.id));
  const dev = locations.get("dev/sp1");
  assert.equal(dev.cwd, "/live");
  assert.equal(dev.machine, "dev");
  assert.deepEqual(dev, locations.get("dev/sp2"));
  assert.equal(locations.get("sp1").cwd, "/live");
  assert.notEqual(dev.key, locations.get("sp1").key);
});

test("runs one read-only argv query on Windows and Unix and isolates matching repo paths by machine", async () => {
  const windows = "C:\\code\\main checkout";
  const unix = "/srv/review's checkout; $(ignored)";
  const spaces = [
    { id: "win", name: "Windows", folder: windows },
    { id: "server-a/main", name: "Main", machine: "server-a", folder: "/srv/repo" },
    { id: "server-b/wt", name: "Review", machine: "server-b", folder: unix },
  ];
  const locations = spaceLocations(spaces, []);
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push([command, args, options]);
    const stdout = options.on === null
      ? "C:/code/main checkout/.git\r\nC:/code/main checkout/.git\r\ntrue\r\n"
      : `${options.on === "server-a" ? "/srv/repo/.git" : "/srv/repo/.git/worktrees/review"}\n/srv/repo/.git\ntrue\n`;
    return { code: 0, stdout };
  };
  const repos = new Map();
  for (const location of locations.values()) repos.set(location.key, await readSpaceRepo(location, exec));
  const argv = ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--is-inside-work-tree"];
  assert.deepEqual(calls, [
    ["git", argv, { cwd: windows, on: null }],
    ["git", argv, { cwd: "/srv/repo", on: "server-a" }],
    ["git", argv, { cwd: unix, on: "server-b" }],
  ]);
  const [win, main, linked] = repos.values();
  assert.equal(win.linked, false);
  assert.equal(main.linked, false);
  assert.equal(linked.linked, true);
  assert.notEqual(main.repo, linked.repo);
  assert.deepEqual(groupSpaceOptions(spaces, locations, repos), [
    ["win", "Windows", `Local · ${windows}`],
    ["server-a/main", "Main", "server-a · /srv/repo"],
    ["server-b/wt", "Review", `server-b · ${unix}`],
  ]);
});

test("treats Git failures and non-checkouts as unknown", async () => {
  const [location] = spaceLocations([{ id: "sp", name: "Repo", folder: "/repo" }], []).values();
  for (const reply of [
    { code: 128, stdout: "" },
    { code: 0, stdout: "/repo/.git\n" },
    { code: 0, stdout: "/repo/.git\n/repo/.git\nfalse\n" },
  ]) {
    assert.equal(await readSpaceRepo(location, async () => reply), null);
  }
  assert.equal(await readSpaceRepo(location, async () => { throw new Error("machine unreachable"); }), null);
  let calls = 0;
  const [noFolder] = spaceLocations([{ id: "home", name: "Home" }], []).values();
  assert.equal(await readSpaceRepo(noFolder, async () => { calls++; }), null);
  assert.equal(calls, 0);
});
