import type {
  PluginLogger,
  PluginServices,
  PluginSessionHandle,
  WorkspaceRef,
} from "@keepdeck/plugin-api";
import {
  commandBanner,
  exitNote,
  runSpawnOptions,
  sameWorkspace,
  spawnFailedNote,
  type RunRequest,
  type RunSession,
} from "./domain";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * The owner of every run session — created PER plugin activation
 * (`createRunManager`), not a module singleton, so disabling the plugin takes
 * its sessions with it (see `stopAll`, called from `deactivate`). Sessions are
 * keyed by their own ids, join no deck state and are never persisted. React
 * reads through `useRunSessions` (a `useSyncExternalStore` bridge over
 * `subscribe`/`getSessions`); the log view attaches like a terminal view does
 * — replay of the ring buffer, then the live stream.
 *
 * Killing goes through the session handle's `close`, which signals the whole
 * process group — a stopped dev server takes its `&`-children with it.
 */

/** A view's ears on one run session's output. */
export interface RunSink {
  onOutput(bytes: Uint8Array): void;
}

/** The plugin-facing run manager: the panel drives everything through it. */
export interface RunManager {
  launchRun(
    workspace: WorkspaceRef,
    target: { worktree: string; branch?: string },
    request: RunRequest,
  ): Promise<string>;
  stopRun(id: string): void;
  restartRun(id: string): Promise<void>;
  removeRun(id: string): void;
  removeDeadRunsFor(workspace: WorkspaceRef, presetId: string): void;
  stopWorkspaceRuns(workspace: WorkspaceRef): void;
  /** Deactivation: kill and forget every session (NEW vs the legacy host
   * manager, which lived for the app's whole lifetime). */
  stopAll(): void;
  attachRun(id: string, sink: RunSink): () => void;
  /** Send input to a running session's PTY (stdin) — the interactive log
   * forwards keystrokes here. A no-op when the session has no live handle (the
   * launch→spawn window, or after it exits). */
  writeRun(id: string, data: string): void;
  resizeRun(id: string, cols: number, rows: number): void;
  getSessions(): RunSession[];
  subscribe(listener: () => void): () => void;
}

/** Replay budget per session; oldest chunks fall off first. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Clear an attached live terminal's viewport + scrollback (ED 2 / ED 3 / home)
 * so it matches the emptied replay buffer on restart. */
const CLEAR_TERMINAL = new TextEncoder().encode("\x1b[2J\x1b[3J\x1b[H");

interface Entry {
  session: RunSession;
  handle: PluginSessionHandle | null;
  sink: RunSink | null;
  chunks: Uint8Array[];
  buffered: number;
  /** Guards against events landing after an explicit remove. */
  removed: boolean;
  /** Last requested terminal size, re-applied when a (re)spawned handle
   * arrives — a resize before the handle exists would otherwise be dropped,
   * stranding the PTY at the spawn placeholder until an unrelated resize. */
  size: { cols: number; rows: number } | null;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

export function createRunManager(
  services: PluginServices,
  log: PluginLogger,
): RunManager {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let seq = 0;
  /** Stable snapshot for `useSyncExternalStore`; rebuilt only on real change. */
  let snapshot: RunSession[] = [];

  function notify(): void {
    snapshot = [...entries.values()].map((e) => e.session);
    for (const listener of [...listeners]) listener();
  }

  function update(id: string, patch: Partial<RunSession>): void {
    const entry = entries.get(id);
    if (!entry) return;
    entry.session = { ...entry.session, ...patch };
    notify();
  }

  function remember(entry: Entry, bytes: Uint8Array): void {
    entry.chunks.push(bytes);
    entry.buffered += bytes.byteLength;
    while (entry.buffered > MAX_BUFFER_BYTES && entry.chunks.length > 1) {
      entry.buffered -= entry.chunks[0].byteLength;
      entry.chunks.shift();
    }
  }

  /** Spawn (or respawn, for restart) the entry's command. */
  function spawn(entry: Entry): void {
    const id = entry.session.id;
    // Echo the command line first (see commandBanner), then stream the process.
    const banner = encode(commandBanner(entry.session.command));
    entry.sink?.onOutput(banner);
    remember(entry, banner);
    void services.sessions
      .spawn(runSpawnOptions(entry.session), (event) => {
        if (entry.removed) return;
        if (event.type === "output") {
          // `PluginSessionEvent.bytes` is already a Uint8Array — stream it.
          entry.sink?.onOutput(event.bytes);
          remember(entry, event.bytes);
        } else {
          entry.handle = null;
          log.info(`${id}: exited (code ${event.code ?? "?"})`);
          const bytes = encode(
            exitNote({
              stopped: entry.session.status.kind === "stopping",
              code: event.code,
            }),
          );
          entry.sink?.onOutput(bytes);
          remember(entry, bytes);
          update(id, { status: { kind: "exited", code: event.code } });
        }
      })
      .then((handle) => {
        if (entry.removed) {
          // Removed while the spawn was in flight — reap immediately.
          void handle.close().catch(() => {});
          return;
        }
        entry.handle = handle;
        // Apply the size the view already requested before the handle existed,
        // so the PTY doesn't stay at the spawn placeholder (RunLog resizes on
        // mount, typically before this resolves).
        if (entry.size) {
          void handle.resize(entry.size.cols, entry.size.rows).catch(() => {});
        }
        // A Stop landed during the launch→spawn window, while the handle was
        // still null — honor it now that the process actually exists.
        if (entry.session.status.kind === "stopping") {
          void handle.close().catch(() => {});
        }
      })
      .catch((e: unknown) => {
        if (entry.removed) return;
        const message = describeError(e);
        log.error(`${id}: spawn failed: ${message}`);
        const bytes = encode(spawnFailedNote(message));
        entry.sink?.onOutput(bytes);
        remember(entry, bytes);
        update(id, { status: { kind: "failed", message } });
      });
  }

  async function restartRun(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry) return;
    const old = entry.handle;
    entry.handle = null;
    if (old) await old.close().catch(() => {});
    const port = await services.ports
      .allocate(entry.session.worktree)
      .catch(() => undefined);
    entry.chunks = [];
    entry.buffered = 0;
    // Clear the attached live terminal too, so it matches the emptied buffer.
    // Otherwise the live log shows the previous run's output above the new one,
    // while a fresh re-attach (buffer only) would show just the new run.
    entry.sink?.onOutput(CLEAR_TERMINAL);
    entry.session = {
      ...entry.session,
      port,
      status: { kind: "running" },
    };
    log.info(`${id}: restart "${entry.session.command}" (port ${port ?? "-"})`);
    notify();
    spawn(entry);
  }

  async function launchRun(
    workspace: WorkspaceRef,
    target: { worktree: string; branch?: string },
    request: RunRequest,
  ): Promise<string> {
    if (request.presetId) {
      const existing = [...entries.values()].find(
        (e) =>
          sameWorkspace(e.session.workspace, workspace) &&
          e.session.presetId === request.presetId &&
          e.session.worktree === target.worktree,
      );
      if (existing) {
        const { kind } = existing.session.status;
        if (kind === "running" || kind === "stopping") return existing.session.id;
        existing.session = {
          ...existing.session,
          name: request.name,
          command: request.command,
          ...(target.branch ? { branch: target.branch } : {}),
        };
        await restartRun(existing.session.id);
        return existing.session.id;
      }
    }
    // `rs-` namespace: preset ids are `run-N`, and the two must never collide
    // (list rows key on either — a shared namespace produced duplicate React
    // keys and phantom rows).
    const id = `rs-${++seq}`;
    const entry: Entry = {
      session: {
        id,
        workspace,
        name: request.name,
        ...(request.presetId && { presetId: request.presetId }),
        command: request.command,
        worktree: target.worktree,
        ...(target.branch && { branch: target.branch }),
        status: { kind: "running" },
      },
      handle: null,
      sink: null,
      chunks: [],
      buffered: 0,
      removed: false,
      size: null,
    };
    // Register BEFORE the first await. The dedup scan above is synchronous, so
    // it can only see entries already in the map: with registration deferred
    // until after port allocation, two launches of the same preset raced
    // through the gap and both spawned.
    entries.set(id, entry);

    const port = await services.ports.allocate(target.worktree).catch((e) => {
      log.warn(`port allocation failed for ${target.worktree}: ${describeError(e)}`);
      return undefined;
    });
    if (port !== undefined) entry.session = { ...entry.session, port };

    log.info(
      `${id}: launch "${request.command}" in ${target.worktree} (port ${port ?? "-"})`,
    );
    notify();
    spawn(entry);
    return id;
  }

  function stopRun(id: string): void {
    const entry = entries.get(id);
    // Guard on the STATUS, not the handle: a Stop clicked in the launch→spawn
    // window (handle still null, row already "running") must not be swallowed.
    if (!entry || entry.session.status.kind !== "running") return;
    log.info(`${id}: stop`);
    update(id, { status: { kind: "stopping" } });
    // Close now if the process exists; otherwise the spawn .then sees the
    // stopping status and closes the handle the moment it arrives.
    if (entry.handle) void entry.handle.close().catch(() => {});
  }

  function removeRun(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    entry.removed = true;
    entry.sink = null;
    entry.chunks = [];
    const handle = entry.handle;
    entry.handle = null;
    if (handle) {
      log.info(`${id}: remove (killing)`);
      void handle.close().catch(() => {});
    }
    entries.delete(id);
    notify();
  }

  function removeDeadRunsFor(
    workspace: WorkspaceRef,
    presetId: string,
  ): void {
    for (const entry of [...entries.values()]) {
      const s = entry.session;
      if (
        sameWorkspace(s.workspace, workspace) &&
        s.presetId === presetId &&
        (s.status.kind === "exited" || s.status.kind === "failed")
      ) {
        removeRun(s.id);
      }
    }
  }

  function stopWorkspaceRuns(workspace: WorkspaceRef): void {
    for (const entry of [...entries.values()]) {
      if (sameWorkspace(entry.session.workspace, workspace))
        removeRun(entry.session.id);
    }
  }

  function stopAll(): void {
    for (const id of [...entries.keys()]) removeRun(id);
    listeners.clear();
    seq = 0;
    snapshot = [];
  }

  function attachRun(id: string, sink: RunSink): () => void {
    const entry = entries.get(id);
    if (!entry) return () => {};
    entry.sink = sink;
    for (const chunk of entry.chunks) sink.onOutput(chunk);
    return () => {
      if (entries.get(id) === entry && entry.sink === sink) entry.sink = null;
    };
  }

  function writeRun(id: string, data: string): void {
    const entry = entries.get(id);
    // Guard on the live handle: no handle means the process doesn't exist yet
    // (launch→spawn window) or has exited. Drop the keystroke rather than queue
    // it — the log arms input only while the session runs, so this is a narrow
    // race, not a lost message.
    if (!entry || !entry.handle) return;
    void entry.handle.write(data).catch(() => {});
  }

  function resizeRun(id: string, cols: number, rows: number): void {
    const entry = entries.get(id);
    if (!entry) return;
    // Remember it even when the handle isn't up yet — the spawn .then applies
    // the latest size once it arrives.
    entry.size = { cols, rows };
    void entry.handle?.resize(cols, rows).catch(() => {});
  }

  return {
    launchRun,
    stopRun,
    restartRun,
    removeRun,
    removeDeadRunsFor,
    stopWorkspaceRuns,
    stopAll,
    attachRun,
    writeRun,
    resizeRun,
    getSessions: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
