# KeepDeck

A desktop **deck for a fleet of coding agents** — launch, watch and control
Claude Code, OpenCode and Codex sessions side by side in one native window.

The throughline is **holding stability under speed**: the aim is observability +
reliability over the fleet, not the renderer.

## Install (macOS)

`./install.sh` builds KeepDeck and installs it to `/Applications`.

```sh
./install.sh
```

It needs the dev toolchain (see [Develop](#develop)); run `pnpm install` first.
The script builds the release `.app`, copies it to `/Applications`, and removes
the quarantine attribute so the unsigned build opens without a Gatekeeper
warning.

Flags:

- `--dest ~/Applications` installs for the current user instead of system-wide.
- `--target universal-apple-darwin` and any other arguments are passed to
  `tauri build`.

If KeepDeck is running, the script replaces the app but does not restart it.
Quit and reopen KeepDeck to load the new version. To build a `.dmg` instead, see
[Package (macOS)](#package-macos).

## What it does

- **Workspaces** — each owns a working directory and its own set of agent panes.
  Switching workspaces keeps the others' sessions running in the background.
  Rename them, drag to reorder in the rail, collapse the rail.
- **Agent grid** — up to 16 live terminals per workspace, each a real PTY session
  running an agent. Add and close agents, maximize one to focus, rename a pane
  (or let it title itself from the terminal), open its directory in VS Code from
  the pane header.
- **Mixed agents** — the agent type is picked per pane, so one workspace can run
  Claude Code, OpenCode and Codex side by side. Installed agents are
  auto-detected.
- **A git worktree per agent** — an agent can run in its own worktree on its own
  branch, created (or attached to an existing one) at spawn through a path
  picker; the pane header shows the branch, and closing the agent offers to
  clean the worktree up. Agents without a worktree just share the workspace
  directory — mixing both in one workspace is fine.
- **Survives restarts** — the deck is saved as you work and restored on launch:
  workspaces, panes, layout. Each pane resumes its own recorded agent session
  natively (`claude --resume`, `codex resume`, `opencode -s`); a pane whose
  folder is gone says so and offers a fresh start in the workspace directory.
- **A terminal that behaves** — URLs and file paths are clickable, even across
  wrapped lines. ⌘C copies the real selection; ⌘V pastes text, or a clipboard
  image as a temp-PNG path; dropping a file onto a pane pastes its path;
  programs in a pane can set the clipboard (OSC 52). Shift+Enter inserts a
  newline instead of submitting.
- **Native menu + hotkeys** — ⌘N new workspace, ⌘T new agent, ⌘W close agent
  (an empty workspace closes itself), ⇧⌘M maximize the focused pane.

## Stack

- **Frontend:** Tauri 2 + React + TypeScript + Vite,
  [xterm.js](https://xtermjs.org).
- **Backend:** a Rust workspace. `src-tauri` is the Tauri app bridging the core
  to the UI (per-session channels, native menu, durable state); the core lives
  in pure-Rust crates with no Tauri dependency:
  - `keepdeck-pty` — PTY process layer (spawns agents via `portable-pty`,
    streams their I/O)
  - `keepdeck-git` — git worktree operations (create, attach, inspect, clean up)
  - `keepdeck-agents` — the agent catalog: detection, spawn commands, resume
    recipes
  - `keepdeck-history` — recorded agent sessions: discovery and validation
  - `keepdeck-env` — PATH/environment resolution for spawned processes
- macOS first, Linux next, Windows later.

## Develop

```sh
pnpm install        # install frontend deps
pnpm tauri dev      # run the desktop app (compiles the Rust backend)
```

Checks:

```sh
pnpm test           # frontend unit tests (Vitest)
pnpm typecheck      # tsc --noEmit
cargo test          # backend tests (Cargo workspace)
```

## Package (macOS)

Build an installable `.dmg`:

```sh
pnpm build:macos    # → target/release/bundle/dmg/KeepDeck_<version>_<arch>.dmg
```

It builds the release `.app` with Tauri, then assembles a plain
drag-to-Applications disk image with `hdiutil`. This is **headless-safe**: it
deliberately skips Tauri's styled-dmg step, whose AppleScript needs macOS
*Automation → Finder* permission and otherwise fails in CI / non-interactive
shells with `Not authorised to send Apple events to Finder. (-1743)`.

- `./build-macos.sh --styled` — use Tauri's prettier dmg instead (run from a
  Terminal that's been granted Automation → Finder).
- `./build-macos.sh --target universal-apple-darwin` — extra args pass through
  to `tauri build` (needs the rustup targets installed).

The build is **unsigned** unless you export `APPLE_SIGNING_IDENTITY` (plus
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` to notarize). An unsigned app
runs locally after clearing quarantine:
`xattr -dr com.apple.quarantine /Applications/KeepDeck.app`.

## License

Apache-2.0 — see [LICENSE](LICENSE).
