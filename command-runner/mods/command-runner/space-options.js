/** @typedef {{id: string, name: string, machine?: string | null, folder?: string, tabs?: {id: string}[]}} Space */
/** @typedef {{tab: string, cwd?: string | null}} Pane */
/** @typedef {{machine: string | null, cwd: string, key: string}} Location */
/** @typedef {{repo: string, linked: boolean}} Repo */
/** @typedef {[id: string, name: string, detail: string, parentName?: string]} SpaceOption */

/**
 * Resolve the first live pane cwd in each space, falling back to its folder.
 * @param {Space[]} spaces
 * @param {Pane[]} panes
 * @returns {Map<string, Location>}
 */
export function spaceLocations(spaces, panes) {
  const spaceByTab = new Map();
  for (const space of spaces) {
    for (const tab of space.tabs ?? []) spaceByTab.set(tab.id, space.id);
  }
  const live = new Map();
  for (const pane of panes) {
    const id = spaceByTab.get(pane.tab);
    if (id !== undefined && pane.cwd && !live.has(id)) live.set(id, pane.cwd);
  }
  return new Map(
    spaces.map((space) => {
      const machine = space.machine ?? null;
      const cwd = live.get(space.id) ?? space.folder ?? "";
      return [space.id, { machine, cwd, key: JSON.stringify([machine, cwd]) }];
    }),
  );
}

/**
 * Read checkout identity without touching the index. Call once per location key.
 * @param {Location} location
 * @param {(command: string, args: string[], options: {cwd: string, on: string | null}) => Promise<{code: number, stdout: string}>} exec
 * @returns {Promise<Repo | null>}
 */
export async function readSpaceRepo({ machine, cwd }, exec) {
  if (!cwd) return null;
  try {
    const { code, stdout } = await exec(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--absolute-git-dir",
        "--git-common-dir",
        "--is-inside-work-tree",
      ],
      { cwd, on: machine },
    );
    if (code !== 0) return null;
    const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    const [gitDir, commonDir, inside] = lines;
    if (lines.length !== 3 || !gitDir || !commonDir || inside !== "true") return null;
    return { repo: JSON.stringify([machine, commonDir]), linked: gitDir !== commonDir };
  } catch {
    return null;
  }
}

/**
 * Keep root and child order, moving linked spaces under their first known main.
 * @param {Space[]} spaces
 * @param {Map<string, Location>} locations
 * @param {Map<string, Repo | null>} repoByLocation Completed lookups keyed by location.key.
 * @returns {SpaceOption[]}
 */
export function groupSpaceOptions(spaces, locations, repoByLocation) {
  const entries = spaces.map((space) => {
    const location = locations.get(space.id);
    const git = location && repoByLocation.get(location.key);
    return { space, location, git };
  });
  /** @type {Map<string, Space>} */
  const mains = new Map();
  for (const { space, git } of entries) {
    if (git && !git.linked && !mains.has(git.repo)) mains.set(git.repo, space);
  }
  /** @type {SpaceOption[]} */
  const roots = [];
  /** @type {Map<string, SpaceOption[]>} */
  const children = new Map();
  for (const { space, location, git } of entries) {
    const detail = `${location?.machine ?? "Local"} · ${location?.cwd || "~"}`;
    const parent = git?.linked ? mains.get(git.repo) : undefined;
    if (!parent) {
      roots.push([space.id, space.name, detail]);
    } else {
      let rows = children.get(parent.id);
      if (!rows) children.set(parent.id, (rows = []));
      rows.push([space.id, space.name, `${parent.name} · ${detail}`, parent.name]);
    }
  }
  return roots.flatMap((row) => [row, ...(children.get(row[0]) ?? [])]);
}
