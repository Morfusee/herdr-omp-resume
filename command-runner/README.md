# Command Runner

Send saved shell commands to existing Herdr terminals without switching tabs. Select a command, space, and tab for each target. The Terminal picker appears when you need to choose a pane. Use **Add target** to prepare a batch and **Saved commands** to manage the list. **Submitted** means the core accepted the input, not that the command succeeded.

**Before installing:** This mod reads live Herdr pane and process metadata and reads the target terminal screen to recognize a prompt. It runs read-only `git rev-parse` in workspace folders, locally or on the space's machine. Clicking **Run** can send one Ctrl+C to a recognized development server before submitting the saved command. It does not make direct network requests, but it can use Herdr's existing remote connections, and saved commands run with the target shell's permissions. Saved command text is persistent Herdr shared state visible to other mods. Do not save secrets.

## Install

Use Herdr Desktop 0.1.16 (the API version this mod targets) with its bundled `workspace-chrome` icons and a connected Herdr core (`hc`). Git with `rev-parse --path-format` is optional: spaces stay selectable without it, but worktrees may not group. No Node.js or npm install is needed at runtime. Install any program your saved command needs on the target machine; the initial `pnpm dev` entry is only an example.

1. Review [RECIPE.md](RECIPE.md) and the files in [`mods/command-runner/`](mods/command-runner/). Use `$HERDR_APP_HOME` if set, or `$HOME/.config/herdr-app` otherwise.
2. Copy only the whole `mods/command-runner/` directory into the app home's `mods/` directory. If that name already exists, do not overwrite it. Copy to an unused name and use that name in the commands and optional button below. Copies share the same saved command list.
3. In a POSIX shell, check the installed folder and open the overlay:

   ```sh
   app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
   herdr-app check "$app_home/mods/command-runner"
   herdr-app do mod.open --name command-runner
   ```

   Continue to `mod.open` only if the check passes. The mod does not dock itself or change `keys.json`. The same `mod.open` command toggles it closed.

## What Run does

- Run checks each target's live address, pane membership, launch identity, and foreground process. It accepts supported interactive shells (Bash, Dash, Fish, Ksh, Sh, Zsh, PowerShell, and Cmd) only with a prompt it recognizes. Custom prompts, drafts, and unknown processes may be refused.
- The only interrupt candidates are Python's `http.server` and recognized `next dev` invocations. A generic `pnpm dev` process is not enough. After one Ctrl+C, Run waits up to five seconds for the original shell and a clean prompt. It does not escalate or send to a replacement process.
- A batch can partially succeed. Failures appear on their own rows, accepted rows are not sent again on the next Run, and the mod does not automatically retry failed writes. If delivery is uncertain, inspect the terminal before retrying. Review every target and command: the checks are not a sandbox.

## Optional: Commands beside Files and Changes

Add the button to your own `tabs` clone, not Herdr's shipped `tabs`. For a shipped layout, clone it first, then point only the clone's tabs block at `my-tabs`. If you already use a personal tabs clone, edit that copy instead.

```sh
herdr-app do layout.clone --name main --as my-layout
herdr-app do mod.clone --name tabs --as my-tabs
```

In the cloned layout, change the tabs block's `content.mod` from `tabs` to `my-tabs`. In `mods/my-tabs/main.js`, use `Button` from `gpui-base` and `run` from `herdr` (extend existing imports if needed). Add this child to the existing toolbar row after Changes:

```js
.child(Button.new("run-commands")
  .accessibility_label("Commands").tab_stop(true)
  .h(26).px(8).rounded(6).cursor_pointer()
  .on_mouse_down("left", (_, cx) => cx.stop_propagation())
  .on_click(() => run("mod.open", { name: "command-runner" }))
  .child("Commands"))
```

Run `herdr-app check "$app_home/mods/my-tabs"` after editing the clone. No toolbar or layout file is included in this package.

## Test

From the collection root, run with Node.js 22.7 or later:

```sh
node --test command-runner/tests/herdr-command-runner.test.mjs command-runner/tests/herdr-space-options.test.mjs
```

The tests do not need a running Herdr window or invoke real shells or Git. For a UI check, open the installed mod and save `echo hello`. Choose a spare terminal at a clean, supported shell prompt, then click **Run**. Check that the row says **Submitted** and the terminal prints `hello` once. Add and remove a second target; the last row's remove button must remain visible and disabled.

To uninstall, close the overlay, undo any optional toolbar edit, and remove only the runner folder you installed. The saved commands remain in Herdr's shared state.