# herdr-omp-resume

Windows-only OMP session recovery for Herdr. The mod records active interactive
OMP sessions and resumes them after a Herdr restart when a kept terminal comes
back as a replacement PowerShell shell.

This is a standalone integration. It does not change your PowerShell profile,
OMP `config.yml`, or other mods.

[Screenshot and rebuild recipe](RECIPE.md)

## What it does

- An OMP extension publishes the current session identity to Herdr with one
  `hc label` call per real identity change.
- A Herdr mod keeps only active OMP sessions in
  `$HERDR_APP_HOME/omp-sessions.json`.
- When the mod starts, it resumes a retained terminal that has a replacement
  PowerShell shell. It sends the saved command once, with no prompt.
- Closing an OMP agent, pane, or space removes its entry. An OMP `/restart`
  keeps the entry.
- A default footer shows the active count as `x OMP Registered`.

## Requirements

- Windows. macOS and Linux are not supported.
- The Herdr app with mod support. The `hc` command must be on `PATH`.
- The OMP CLI (`omp`) on `PATH`, with at least one interactive session.
- PowerShell 7 (`pwsh`) for the installer. Recovery shells must be `pwsh.exe`
  or `powershell.exe`.
- Node.js on `PATH`. The Herdr mod runs `node -e` to test whether a session
  file exists.
- Bun only to run the repository tests. OMP supplies the runtime for the hook;
  the hook has no package dependencies.

Check the tools:

```powershell
pwsh --version
node --version
hc --help
Get-Command omp
Get-Command herdr-app
```

## Install

```powershell
git clone https://github.com/Morfusee/herdr-omp-resume.git
cd herdr-omp-resume
pwsh -NoProfile -File ./install.ps1
```

Preview the install without changes:

```powershell
pwsh -NoProfile -File ./install.ps1 -WhatIf
```

Use explicit home directories:

```powershell
pwsh -NoProfile -File ./install.ps1 -AppHome "$HOME\.config\herdr-app" -OmpAgentHome "$HOME\.omp\agent"
```

| Option | Default |
| --- | --- |
| `-AppHome` | `$HERDR_APP_HOME`, else `$HOME\.config\herdr-app` |
| `-OmpAgentHome` | `$HOME\.omp\agent` |
| `-WhatIf` | Report planned changes. Make no changes. |

The installer stops if `OMP_PROFILE` or `PI_CODING_AGENT_DIR` is set and you do
not pass `-OmpAgentHome`. This prevents an implicit install into another OMP
profile.

The installer copies real files. It does not use symlinks, does not request
administrator rights, and refuses linked target directories.

## Installed files

`-AppHome` receives the mod:

```text
mods/omp-resume/main.js
mods/omp-resume/registry.js
mods/omp-resume/mod.json
mods/omp-resume/LICENSE
mods/omp-resume/omp/revive.ts
```

`-OmpAgentHome` receives the self-contained OMP hook:

```text
extensions/herdr-omp-resume.ts
```

`mods/omp-resume/omp/revive.ts` is the bundled source for the hook. Herdr
loads `main.js`; OMP loads the copy under `extensions/`.

The installer replaces only these owned files. It preserves
`omp-sessions.json`, `shared.json`, layouts, other mods, and other extensions.
A differing installed hook is backed up before replacement. The five mod
files are updated in place.
An unchanged rerun does not rewrite installed files or create extra backups.

## Update and restart

```powershell
git pull
pwsh -NoProfile -File ./install.ps1
```

Pass the same `-AppHome` or `-OmpAgentHome` values again if you did not use the
defaults.

The installer does not restart Herdr or OMP. It never restarts a user process.

- An OMP session that is already open needs one manual `/restart` after the
  first install or after a hook update. New OMP sessions load the hook when
  they start.
- Restart Herdr manually if the footer does not appear. A normal mod reload
  also picks up changed mod files.

## Default footer and custom status bar

After the first load, Herdr gives the mod its default bottom footer
(`place: "bottom"`, `size: 28`). The footer shows `x OMP Registered`, where `x`
is the number of active entries.

To show the count in an existing custom status bar, read the shared keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `omp-resume.registered` | number | Active OMP sessions. |
| `omp-resume.error` | string or `null` | Last registry error. `null` means no error. |
| `omp-resume.refresh` | number | Timestamp. Set a new value to request a retry. |

Counter snippet for a status bar mod:

```js
import { div } from "gpui-kit";
import { shared, setShared } from "herdr";

// Add to the render chain.
const registered = shared("omp-resume.registered") ?? 0;

div()
  .id("omp-registered")
  .cursor_pointer()
  .on_click(() => setShared("omp-resume.refresh", Date.now()))
  .child(`${registered} OMP Registered`);
```

Shared state changes re-render every mod. Do not poll it.

The counter is not enough by itself. The registry loop runs only while an
`omp-resume` block is mounted. Add this 1px service block to the same status
row:

```json
{
  "id": "omp-resume-service",
  "type": "block",
  "content": { "mod": "omp-resume", "props": { "service": true } },
  "size": { "px": 1 }
}
```

`props.service: true` makes the copy render empty. The block must stay in the
layout. Do not set `hidden`, and do not remove it. Without a mounted block,
the mod does not reconcile the registry.

If you use the service block, remove the default `omp-resume` footer from the
layout. Do not delete the mod folder. If the layout already has an
`omp-resume` block, move that same block into the status row and add the
service props. Do not add a second block. Two copies run two registry loops
over the same file.

## How recovery works

### Registration

The OMP hook reacts to session start, switch, branch, tree, agent end, and turn
end events. It publishes a JSON label with `sessionId`, `sessionFile`, `cwd`,
and `profile`.

The hook ignores sessions that cannot be the pane's interactive agent:

- sessions without a UI;
- subagents;
- nested OMP processes (`OMPCODE=1`);
- print, JSON, RPC, and RPC-UI launches;
- sessions started with `--no-session`;
- processes without `HC_TERMINAL_ID`.

An explicit `--profile` or `--profile=` wins over `OMP_PROFILE`. The default
profile is stored as `null`.

### Active-only registry

Each entry stores the terminal, pane, space, tab and their names, the working
directory, the session ID and file, the profile, the command argument array,
the root PID, and the terminal creation time.

The command array is rebuilt from the saved identity:

```text
omp [--profile <profile>] --session-dir <session-directory> --resume <session-id>
```

A version 2 record whose command array does not match the rebuilt command is
rejected. The JSON file cannot inject an arbitrary command.

The registry has no closed-session history:

- a session switch replaces the previous entry;
- closing an agent, pane, or space removes the entry;
- an OMP exit removes the entry even if its shell remains;
- a reused terminal address does not inherit an old conversation;
- an OMP `/restart` keeps the identity, because the hook does not publish on
  session shutdown.

The mod does not scan session directories, check session locks or leases,
inspect open file handles, search for processes, or call `/session info`.
For session availability, it tests only whether the saved session file exists.

### Startup recovery

Automatic recovery is limited to a retained replacement PowerShell pane. All
of these conditions must hold:

- the terminal still has the same pane, tab, space, and creation time;
- Herdr keeps the terminal;
- the foreground process is a replacement `pwsh.exe` or `powershell.exe`;
- no agent or other program is running in the terminal;
- the terminal has not reported a program, and the same resume was not
  attempted before.

The mod sends the saved command once. It uses `--resume`, not `--restore`, and
it submits no prompt. An attempt label prevents a second send during a reload.

The mod does not reopen a closed pane. It does not type into a live agent, a
busy terminal, an ordinary shell return, or another program. It does not
recover remote spaces or other agent applications.

If OMP has not saved the conversation yet, the session file is missing. The mod
skips recovery and shows a warning. Continue the conversation in OMP so OMP
saves the file; recovery can work on a later start.

## Privacy

`$HERDR_APP_HOME/omp-sessions.json` contains private data:

- absolute session and working-directory paths;
- session IDs and profiles;
- terminal, pane, space, and tab names;
- process IDs.

The file stays on this computer. The mod and installer do not send it to a
network service. The installer preserves it across updates. The repository
`.gitignore` excludes it and `shared.json`. Do not commit it or attach it to an
issue.

## Checks

Run the repository checks with Bun, PowerShell 7, and the installed Herdr app:

```powershell
bun tests/test_herdr_omp_resume.mjs
bun tests/test_herdr_omp_hook.mjs
pwsh -NoProfile -File tests/test_install.ps1
herdr-app check "$HOME/.config/herdr-app/mods/omp-resume"
```

Use your `-AppHome` path in the last command if it is not the default. For a
running app, `herdr-app status` reports layout and mod errors. These checks do
not restart Herdr or OMP.

## Credits and license

The hook lifecycle approach and PowerShell quoting are adapted from
[Revive for Windows](https://github.com/RAF1337/herdr-revive-win) by Devrim
Mazlum and René Frandsen. The retained upstream MIT notice is at
`mods/omp-resume/LICENSE`, with Copyright 2026 Devrim Mazlum and René Frandsen.

This repository is MIT licensed. See `LICENSE`. Copyright 2026 Morfusee.
