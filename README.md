# KeepDeck

Local-first desktop **cockpit for a fleet of coding agents** (Claude Code / opencode):
launch, observe and control them in one window. The differentiator is
observability + reliability — *hold stability under speed* — not the renderer.

> Status: **greenfield skeleton.** This repo currently boots a Tauri shell that
> renders one xterm.js terminal pane and proves the React ↔ Rust IPC bridge.
> PTY-backed sessions and the observability-tap land next.

## Stack

- **Frontend:** Tauri 2 + React + Vite + TypeScript, [xterm.js](https://xtermjs.org) (WebGL addon).
- **Backend:** Rust (`src-tauri`). PTY session base + observability-tap arrive in later steps.
- **Local-first, cloud-optional.** Mac first, Linux second, Windows later.

## Develop

```sh
pnpm install        # install frontend deps
pnpm tauri dev      # run the desktop app (compiles the Rust backend)
```

Useful checks:

```sh
pnpm test           # frontend unit tests (Vitest)
pnpm typecheck      # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml   # backend unit tests
```

## Layout

```
src/                React UI (cockpit shell, terminal pane, IPC, layout helpers)
src-tauri/          Rust backend (Tauri app, commands)
```
