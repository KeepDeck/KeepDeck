import {
  runSpawnOptions,
  type RunRequest,
  type RunSession,
} from "../domain/run";
import { describeError, log } from "../ipc/log";
import { allocatePorts } from "../ipc/ports";
import { spawnSession, type Session } from "../ipc/session";

/**
 * The owner of every run session (experimental run presets) — one per app,
 * outside React, like `ptyManager` and `settingsManager`, but deliberately
 * SEPARATE from the agent machinery: sessions are keyed by their own ids,
 * join no deck state and are never persisted. React reads through
 * `useRunSessions` (a `useSyncExternalStore` bridge); the Run panel's log
 * view attaches like a terminal view does — replay of the ring buffer, then
 * the live stream.
 *
 * Killing goes through the generic session close, which signals the whole
 * process group — a stopped dev server takes its `&`-children with it.
 */

/** A view's ears on one run session's output. */
export interface RunSink {
  onOutput(bytes: Uint8Array): void;
}

/** Replay budget per session; oldest chunks fall off first. */
const MAX_BUFFER_BYTES = 1024 * 1024;

interface Entry {
  session: RunSession;
  handle: Session | null;
  sink: RunSink | null;
  chunks: Uint8Array[];
  buffered: number;
  /** Guards against events landing after an explicit remove. */
  removed: boolean;
}

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

/**
 * Launch `request` in `target` for workspace `wsId` and return the session
 * id. The port block is allocated first so the env contract rides the spawn;
 * allocation failure degrades to an env without `KEEPDECK_PORT` (the command
 * still runs and fails visibly if it needed one).
 *
 * Launching a preset that already has a session in this target REPLACES a
 * dead one (fresh buffer and port, the preset's CURRENT command — it may
 * have been edited since) and is a no-op on a live one: the list stays
 * bounded by commands × targets, never by click history.
 */
export async function launchRun(
  wsId: string,
  target: { worktree: string; branch?: string },
  request: RunRequest,
): Promise<string> {
  if (request.presetId) {
    const existing = [...entries.values()].find(
      (e) =>
        e.session.wsId === wsId &&
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
  const port = await allocatePorts(target.worktree).catch((e) => {
    log.warn(
      "web:run",
      `port allocation failed for ${target.worktree}: ${describeError(e)}`,
    );
    return undefined;
  });
  const entry: Entry = {
    session: {
      id,
      wsId,
      name: request.name,
      ...(request.presetId && { presetId: request.presetId }),
      command: request.command,
      worktree: target.worktree,
      ...(target.branch && { branch: target.branch }),
      ...(port !== undefined && { port }),
      status: { kind: "running" },
    },
    handle: null,
    sink: null,
    chunks: [],
    buffered: 0,
    removed: false,
  };
  entries.set(id, entry);
  log.info(
    "web:run",
    `${id}: launch "${request.command}" in ${target.worktree} (port ${port ?? "-"})`,
  );
  notify();
  spawn(entry);
  return id;
}

/** Spawn (or respawn, for restart) the entry's command. */
function spawn(entry: Entry): void {
  const id = entry.session.id;
  // Echo the command line first, the way a shell shows what it's about to
  // run. The Commands list only ever shows a preset's NAME; the log is where
  // the actual command becomes visible — including one edited in deck.json
  // (a plain file) behind a familiar name. Newlines are normalized so a
  // multi-line script doesn't stair-step across the terminal grid.
  const echo = entry.session.command.replace(/\r?\n/g, "\r\n");
  const banner = new TextEncoder().encode(`\x1b[90m[run] ${echo}\x1b[0m\r\n`);
  entry.sink?.onOutput(banner);
  remember(entry, banner);
  spawnSession(runSpawnOptions(entry.session), (event) => {
    if (entry.removed) return;
    if (event.type === "output") {
      const bytes = new Uint8Array(event.bytes);
      entry.sink?.onOutput(bytes);
      remember(entry, bytes);
    } else {
      entry.handle = null;
      log.info("web:run", `${id}: exited (code ${event.code ?? "?"})`);
      // The run's end belongs in its own log, like agent panes do — the
      // status chip alone leaves the log ending mid-stream. A `stopping`
      // session died because the user pulled the plug: say that instead of
      // the kill signal's exit code.
      const note =
        entry.session.status.kind === "stopping"
          ? "[stopped]"
          : `[process exited${event.code != null ? ` (${event.code})` : ""}]`;
      const bytes = new TextEncoder().encode(`\r\n\x1b[90m${note}\x1b[0m\r\n`);
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
    })
    .catch((e: unknown) => {
      if (entry.removed) return;
      const message = describeError(e);
      log.error("web:run", `${id}: spawn failed: ${message}`);
      // The failure belongs in the session's own log, like any other output —
      // a status note alone ("spawn failed") hides the WHY (e.g. the
      // worktree was deleted: the OS error names the missing directory).
      const bytes = new TextEncoder().encode(
        `\x1b[31mspawn failed: ${message}\x1b[0m\r\n`,
      );
      entry.sink?.onOutput(bytes);
      remember(entry, bytes);
      update(id, { status: { kind: "failed", message } });
    });
}

/** Stop the run (SIGTERM to the group, SIGKILL after the grace period). The
 * status flips to `stopping` until the exit event lands. */
export function stopRun(id: string): void {
  const entry = entries.get(id);
  if (!entry?.handle) return;
  log.info("web:run", `${id}: stop`);
  update(id, { status: { kind: "stopping" } });
  void entry.handle.close().catch(() => {});
}

/**
 * Run the command again: kill whatever still lives, drop the old output, and
 * respawn with a fresh port probe (the old block may have been taken while
 * the session sat exited).
 */
export async function restartRun(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry) return;
  const old = entry.handle;
  entry.handle = null;
  if (old) await old.close().catch(() => {});
  const port = await allocatePorts(entry.session.worktree).catch(() => undefined);
  entry.chunks = [];
  entry.buffered = 0;
  entry.session = {
    ...entry.session,
    port,
    status: { kind: "running" },
  };
  log.info("web:run", `${id}: restart "${entry.session.command}" (port ${port ?? "-"})`);
  notify();
  spawn(entry);
}

/** Drop the session from the panel, killing it first if it still runs. */
export function removeRun(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.removed = true;
  entry.sink = null;
  entry.chunks = [];
  const handle = entry.handle;
  entry.handle = null;
  if (handle) {
    log.info("web:run", `${id}: remove (killing)`);
    void handle.close().catch(() => {});
  }
  entries.delete(id);
  notify();
}

/** A preset was deleted: sweep its DEAD sessions (nothing running to
 * protect — leaving them made the deletion look like it didn't work); a
 * live one stays visible as an orphan row until it stops. */
export function removeDeadRunsFor(wsId: string, presetId: string): void {
  for (const entry of [...entries.values()]) {
    const s = entry.session;
    if (
      s.wsId === wsId &&
      s.presetId === presetId &&
      (s.status.kind === "exited" || s.status.kind === "failed")
    ) {
      removeRun(s.id);
    }
  }
}

/** A workspace is closing: its runs die with it — nothing may leak. */
export function stopWorkspaceRuns(wsId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.session.wsId === wsId) removeRun(entry.session.id);
  }
}

/** Point a log view at the session: buffered output replays first, then the
 * live stream. Returns the detach fn; detaching never stops the process. */
export function attachRun(id: string, sink: RunSink): () => void {
  const entry = entries.get(id);
  if (!entry) return () => {};
  entry.sink = sink;
  for (const chunk of entry.chunks) sink.onOutput(chunk);
  return () => {
    if (entries.get(id) === entry && entry.sink === sink) entry.sink = null;
  };
}

/** Sync the PTY grid to the log view's real size. No-op after exit. */
export function resizeRun(id: string, cols: number, rows: number): void {
  void entries.get(id)?.handle?.resize(cols, rows).catch(() => {});
}

/** Snapshot of every run session (all workspaces; callers filter). Stable
 * between changes — the `useSyncExternalStore` contract. */
export function getRunSessions(): RunSession[] {
  return snapshot;
}

/** Notify on every session change (the `useSyncExternalStore` contract). */
export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: kill and forget everything. */
export function resetRunManager(): void {
  for (const id of [...entries.keys()]) removeRun(id);
  listeners.clear();
  seq = 0;
  snapshot = [];
}

function remember(entry: Entry, bytes: Uint8Array): void {
  entry.chunks.push(bytes);
  entry.buffered += bytes.byteLength;
  while (entry.buffered > MAX_BUFFER_BYTES && entry.chunks.length > 1) {
    entry.buffered -= entry.chunks[0].byteLength;
    entry.chunks.shift();
  }
}
