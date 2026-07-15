import { spawnSession, type Session } from "../ipc/session";
import { describeError, log } from "../ipc/log";

/**
 * The owner of every live PTY session, keyed by pane id. A `TerminalPane` is
 * only a view: it attaches to its pane's session on mount and detaches on
 * unmount — the process itself lives here and dies only through an explicit
 * [`closePane`] from a deck action (close agent / close workspace).
 *
 * Why ownership is out of React: a session acquired inside an effect lives and
 * dies with the *mount*, so a dev StrictMode double-mount spawned a throwaway
 * process (same `--session-id`, briefly two live claudes), and any future
 * remount would kill a working agent. [`acquirePane`] is idempotent per
 * (pane, command, cwd) — correct under any effect ordering, with no timing
 * assumptions about React internals.
 *
 * One global manager, not one per workspace: pane ids are unique across the
 * deck (a single mint sequence), the Rust `SessionRegistry` behind the IPC is
 * already app-global, and a workspace close is just a bulk [`closePanes`] over
 * its pane ids. If remote hosts ever arrive, the key grows a host part here.
 *
 * Output is mirrored into a bounded per-pane ring buffer at all times, so a
 * re-attaching view (remount) replays recent history into its fresh xterm
 * instead of starting blank. Replay may begin mid-escape-sequence after the
 * ring trims — the first full TUI repaint (the attach-time resize SIGWINCH)
 * settles any visual artifact.
 */

/** What a pane runs — mirrors the `TerminalPane` props / Rust `SpawnSpec`. */
export interface PaneSpawnSpec {
  /** Program to run; omitted/null spawns the user's shell. */
  command?: string | null;
  /** Read once at spawn time; later changes never restart a live session. */
  args?: string[];
  /** Read once at spawn time, like `args`. */
  env?: [string, string][];
  cwd?: string | null;
  cols: number;
  rows: number;
}

/** A view's ears: everything a session reports back to its pane. */
export interface PaneSink {
  onOutput(bytes: Uint8Array): void;
  /** The PTY process ended (session stays inspectable until [`closePane`]).
   * `replayed` distinguishes the live event from [`attachPane`]'s re-announce
   * to a remounting view: the view needs both (the exit card must survive a
   * remount), but reactions that must fire once per ACTUAL death — the crash
   * notification — listen only to `replayed === false`. */
  onExit(code: number | null, replayed: boolean): void;
  /** The spawn itself failed — there is no process. */
  onSpawnError(message: string): void;
  /** The session is live: sync the PTY size to the view now. Fires on spawn
   * resolution and on attach to an already-live session. */
  onReady(): void;
  /** The program produced its first output — it has painted its first frame,
   * i.e. the CLI has actually launched (distinct from `onReady`, which only
   * means the PTY process exists). Fires once per session; a later attach to an
   * already-launched session is told immediately, after the replay. */
  onLaunched(): void;
}

/** Replay budget per pane; oldest chunks fall off first. */
const MAX_BUFFER_BYTES = 1024 * 1024;

interface Entry {
  paneId: string;
  /** Spawn identity: command + cwd. Args/env are spawn-time-only by design
   * (resume ids go stale the moment the session runs), so they don't key. */
  key: string;
  session: Session | null;
  sink: PaneSink | null;
  chunks: Uint8Array[];
  buffered: number;
  exited: { code: number | null } | null;
  failed: string | null;
  closed: boolean;
  /** The process has emitted at least one output chunk — the "CLI launched"
   * signal. Lives on the entry (not the view) so it survives a re-attach: a
   * workspace switch back to a running agent must not replay the launch
   * animation. */
  launched: boolean;
}

const entries = new Map<string, Entry>();

function identity(spec: PaneSpawnSpec): string {
  return `${spec.command ?? ""}\u0000${spec.cwd ?? ""}`;
}

/**
 * Ensure `paneId` has a session running `spec`. Idempotent: a live (or
 * in-flight, or exited-but-not-closed) session with the same identity is
 * reused — an exited one is NOT silently respawned; restart is an explicit
 * user action ([U4]). A different identity (the pane moved cwd, e.g.
 * start-fresh after a lost worktree) closes the old session and spawns anew.
 */
export function acquirePane(paneId: string, spec: PaneSpawnSpec): void {
  const existing = entries.get(paneId);
  if (existing && existing.key === identity(spec) && existing.failed === null) {
    return;
  }
  if (existing) void closePane(paneId);

  const entry: Entry = {
    paneId,
    key: identity(spec),
    session: null,
    sink: null,
    chunks: [],
    buffered: 0,
    exited: null,
    failed: null,
    closed: false,
    launched: false,
  };
  entries.set(paneId, entry);
  log.info("web:pty", `${paneId}: spawn ${spec.command ?? "(shell)"} in ${spec.cwd ?? "(app cwd)"}`);

  spawnSession(
    {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
    },
    (event) => {
      if (entry.closed) return;
      if (event.type === "output") {
        const bytes = new Uint8Array(event.bytes);
        entry.sink?.onOutput(bytes);
        if (!entry.launched) {
          // First byte from the process: the CLI has painted — announce the
          // launch once, then never again for this session.
          entry.launched = true;
          entry.sink?.onLaunched();
        }
        remember(entry, bytes);
      } else {
        entry.exited = { code: event.code };
        entry.session = null;
        log.info("web:pty", `${paneId}: exited (code ${event.code ?? "?"})`);
        entry.sink?.onExit(event.code, false);
      }
    },
  )
    .then((session) => {
      if (entry.closed) {
        // The pane was closed while the spawn was in flight — reap the
        // process the moment it exists.
        void session.close().catch(() => {});
        return;
      }
      entry.session = session;
      entry.sink?.onReady();
    })
    .catch((err: unknown) => {
      if (entry.closed) return;
      entry.failed = describeError(err);
      log.error("web:pty", `${paneId}: spawn failed: ${entry.failed}`);
      entry.sink?.onSpawnError(entry.failed);
    });
}

/**
 * Point the pane's view at its session: recent output replays first, then the
 * session's current state (ready / exited / failed) is announced. Returns the
 * detach fn for the view's cleanup — detaching leaves the session running.
 */
export function attachPane(paneId: string, sink: PaneSink): () => void {
  const entry = entries.get(paneId);
  if (!entry) return () => {};
  entry.sink = sink;
  for (const chunk of entry.chunks) sink.onOutput(chunk);
  if (entry.failed !== null) sink.onSpawnError(entry.failed);
  else if (entry.exited) sink.onExit(entry.exited.code, true);
  else if (entry.session) sink.onReady();
  // Already-launched session (re-attach): tell the view now, after the replay,
  // so it opens without the launch overlay instead of flashing it again.
  if (entry.launched) sink.onLaunched();
  return () => {
    // Only detach if this sink is still the current one — a re-mount may have
    // already attached its own before the old cleanup ran.
    if (entries.get(paneId) === entry && entry.sink === sink) entry.sink = null;
  };
}

/**
 * Whether the pane's session has already emitted output (the CLI has launched).
 * A view reads this at mount to decide whether to open with the launch overlay:
 * a fresh (or unknown) pane hasn't launched → show it; a re-attach to a running
 * session has → skip it, no flash.
 */
export function isPaneLaunched(paneId: string): boolean {
  return entries.get(paneId)?.launched ?? false;
}

/** Write keystrokes/text into the pane's PTY. No-op without a live session
 * (writes racing a close are normal noise, deliberately unlogged). */
export function writePane(paneId: string, data: string): void {
  void entries.get(paneId)?.session?.write(data).catch(() => {});
}

/** Sync the PTY grid to the view. Same no-op semantics as [`writePane`]. */
export function resizePane(paneId: string, cols: number, rows: number): void {
  void entries.get(paneId)?.session?.resize(cols, rows).catch(() => {});
}

/**
 * End the pane's session for real — THE only path that kills the process.
 * Resolves once the close IPC settles (a worktree delete may need the cwd
 * freed). Safe on unknown/already-closed panes.
 */
export function closePane(paneId: string): Promise<void> {
  const entry = entries.get(paneId);
  if (!entry) return Promise.resolve();
  entries.delete(paneId);
  entry.closed = true;
  entry.sink = null;
  entry.chunks = [];
  entry.buffered = 0;
  const session = entry.session;
  entry.session = null;
  if (!session) return Promise.resolve();
  log.info("web:pty", `${paneId}: close`);
  return session.close().catch((e) => {
    // Usually "already gone" (the process exited and reaped itself).
    log.debug("web:pty", `${paneId}: close failed: ${describeError(e)}`);
  });
}

/** Close a batch (a workspace teardown). Settles when every close has. */
export function closePanes(paneIds: string[]): Promise<void> {
  return Promise.allSettled(paneIds.map(closePane)).then(() => undefined);
}

/** Test hook: drop every entry, closing what's live. */
export function resetPtyManager(): void {
  for (const id of [...entries.keys()]) void closePane(id);
}

function remember(entry: Entry, bytes: Uint8Array): void {
  entry.chunks.push(bytes);
  entry.buffered += bytes.byteLength;
  while (entry.buffered > MAX_BUFFER_BYTES && entry.chunks.length > 1) {
    entry.buffered -= entry.chunks[0].byteLength;
    entry.chunks.shift();
  }
}
