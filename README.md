# KeepDeck

A desktop **deck for a fleet of coding agents** — launch, watch and control
Claude Code / OpenCode / Codex sessions side by side in one native window.

The throughline is **holding stability under speed**: the aim is observability +
reliability over the fleet, not the renderer. (The observability layer is on the
roadmap; today KeepDeck is the deck that runs and organizes the fleet.)

> Status: early (0.3.x), but functional — it runs real coding agents in a
> multi-pane grid, organized into workspaces.

## What it does

- **Workspaces** — each owns a working directory, an agent type, and its own set
  of agent panes. Switching workspaces keeps the others' sessions running in the
  background.
- **Spawn form** — create a workspace by naming it, picking a working directory,
  an agent (Claude Code / OpenCode / Codex), and how many agents to start.
- **Agent grid** — a square-ish grid of live terminals (up to 16), each a real
  PTY session running the chosen agent in the workspace's directory. Add/close
  agents, maximize one to focus, rename/close workspaces, collapse the rail.

Agents run on your machine, in your directories — nothing is uploaded or hosted.

## Stack

- **Frontend:** Tauri 2 + React + Vite + TypeScript, [xterm.js](https://xtermjs.org)
  (canvas renderer).
- **Backend:** Rust. `crates/keepdeck-pty` is the PTY process layer (spawns agents
  via `portable-pty`, streams their I/O); `src-tauri` is the Tauri app that bridges
  it to the UI over per-session channels.
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

## Layout

```
src/                  React UI (deck shell, workspaces, agent panes, terminal)
src-tauri/            Tauri app — session commands + plugins
crates/keepdeck-pty/  Pure-Rust PTY process layer (no Tauri dependency)
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
