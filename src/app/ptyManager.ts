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
 * deck (a single mint sequence), and the Rust `SessionRegistry` behind the IPC
 * is already app-global. If remote hosts ever arrive, the key grows a host
 * part here.
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
  envDefaults?: [string, string][];
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
  /** The spawn itself failed — there is no process. Same `replayed` contract
   * as [`onExit`]: the view renders the failure either way, once-per-failure
   * reactions (the notification) listen only to `replayed === false`. */
  onSpawnError(message: string, replayed: boolean): void;
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
  chunks: Uint8Array[];
  buffered: number;
  exited: { code: number | null } | null;
  /** A sink actually HEARD the exit (live or first re-announce). An exit can
   * land in the detached window between an effect's cleanup and the next
   * attach — the first attach after such a death must announce it as live
   * (once-per-death reactions run), not as a replay. */
  exitAnnounced: boolean;
  failed: string | null;
  /** [`exitAnnounced`]'s mirror for spawn failures — same detached-window
   * reasoning, same once-per-failure guarantee. */
  failedAnnounced: boolean;
  closed: boolean;
  /** The process has emitted at least one output chunk — the "CLI launched"
   * signal. Lives on the entry (not the view) so it survives a re-attach: a
   * workspace switch back to a running agent must not replay the launch
   * animation. */
  launched: boolean;
}

/**
 * What the app knows about a pane's process, for everything that is NOT the
 * terminal view: the card that has to say "exited", and the reconciler that
 * compares what should be running against what is.
 *
 * Read, never copied. An exit kept as component state outlived the process it
 * described — a pane that exited, was suspended and then resumed painted a
 * dead "Agent exited" veil, with a live Restart button, over a fresh terminal.
 * Derived from the session registry, the answer cannot outlive its subject:
 * [`closePane`] drops the entry, and the veil goes with it.
 */
export type PaneSessionState =
  /** No session — never started, or ended by an explicit close. */
  | { kind: "none" }
  /** The spawn is in flight; the process does not exist yet. */
  | { kind: "starting" }
  | { kind: "live" }
  /** The process ended. Stays inspectable until [`closePane`]. */
  | { kind: "exited"; code: number | null }
  /** The spawn itself failed — there was never a process. */
  | { kind: "failed"; message: string };

const entries = new Map<string, Entry>();

/**
 * The views listening to each pane, kept OUTSIDE the session entry.
 *
 * A view used to be reachable only through the entry, which made the order of
 * `acquirePane` and `attachPane` load-bearing: a terminal that attached first
 * found no entry, got a no-op detach, and sat empty forever. That was safe
 * only while the same effect did both. With the spawn owned by the
 * orchestrator the two happen independently, so the listener has to be able to
 * arrive first — and, having arrived, to survive the session being replaced
 * under it (a restart hands the same view a new process).
 */
const sinks = new Map<string, PaneSink>();

/** Shared so an absent pane always answers with the SAME object: consumers
 * subscribe through `useSyncExternalStore`, which re-renders forever on a
 * snapshot rebuilt at every read. */
const NO_SESSION: PaneSessionState = { kind: "none" };
const states = new Map<string, PaneSessionState>();
const stateListeners = new Set<() => void>();

function setSessionState(paneId: string, next: PaneSessionState): void {
  states.set(paneId, next);
  for (const listener of [...stateListeners]) listener();
}

/** This pane's process state. Stable between changes. */
export function paneSessionState(paneId: string): PaneSessionState {
  return states.get(paneId) ?? NO_SESSION;
}

/** Notify on every process-state change, for any pane. */
export function subscribeSessions(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

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
    chunks: [],
    buffered: 0,
    exited: null,
    exitAnnounced: false,
    failed: null,
    failedAnnounced: false,
    closed: false,
    launched: false,
  };
  entries.set(paneId, entry);
  setSessionState(paneId, { kind: "starting" });
  log.info("web:pty", `${paneId}: spawn ${spec.command ?? "(shell)"} in ${spec.cwd ?? "(app cwd)"}`);

  spawnSession(
    {
      command: spec.command,
      args: spec.args,
      env: spec.env,
      envDefaults: spec.envDefaults,
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
    },
    (event) => {
      if (entry.closed) return;
      if (event.type === "output") {
        const bytes = new Uint8Array(event.bytes);
        // First byte from the process: the CLI has painted. The flag is set
        // BEFORE the view is touched — a sink that throws must not be able to
        // leave the pane "not launched" forever while its process is alive and
        // printing, nor to swallow the chunk the replay buffer owes a remount.
        const firstOutput = !entry.launched;
        if (firstOutput) entry.launched = true;
        try {
          sinks.get(paneId)?.onOutput(bytes);
        } catch (err) {
          log.error("web:pty", `${paneId}: onOutput threw: ${describeError(err)}`);
        }
        if (firstOutput) {
          // Announced after the output, matching [`attachPane`]'s replay order:
          // the view paints its first frame, then drops the launch overlay.
          try {
            sinks.get(paneId)?.onLaunched();
          } catch (err) {
            log.error("web:pty", `${paneId}: onLaunched threw: ${describeError(err)}`);
          }
        }
        remember(entry, bytes);
      } else {
        entry.exited = { code: event.code };
        entry.session = null;
        setSessionState(paneId, { kind: "exited", code: event.code });
        log.info("web:pty", `${paneId}: exited (code ${event.code ?? "?"})`);
        const sink = sinks.get(paneId);
        if (sink) {
          entry.exitAnnounced = true;
          sink.onExit(event.code, false);
        }
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
      // An exit can land before the spawn promise settles (a process that dies
      // immediately) — the death is the later truth, so it must not be undone.
      if (!entry.exited) setSessionState(paneId, { kind: "live" });
      sinks.get(paneId)?.onReady();
    })
    .catch((err: unknown) => {
      if (entry.closed) return;
      entry.failed = describeError(err);
      setSessionState(paneId, { kind: "failed", message: entry.failed });
      log.error("web:pty", `${paneId}: spawn failed: ${entry.failed}`);
      const sink = sinks.get(paneId);
      if (sink) {
        entry.failedAnnounced = true;
        sink.onSpawnError(entry.failed, false);
      }
    });
}

/**
 * Point the pane's view at its session: recent output replays first, then the
 * session's current state (ready / exited / failed) is announced. Returns the
 * detach fn for the view's cleanup — detaching leaves the session running.
 *
 * Attaching BEFORE there is a session is fine and expected: the view mounts
 * when the deck renders it, the process starts when the orchestrator decides
 * it should, and neither waits for the other. The listener is simply recorded
 * and hears the session from its first event.
 */
export function attachPane(paneId: string, sink: PaneSink): () => void {
  sinks.set(paneId, sink);
  const detach = () => {
    // Only detach if this sink is still the current one — a re-mount may have
    // already attached its own before the old cleanup ran.
    if (sinks.get(paneId) === sink) sinks.delete(paneId);
  };
  const entry = entries.get(paneId);
  if (!entry) return detach;
  for (const chunk of entry.chunks) sink.onOutput(chunk);
  if (entry.failed !== null) {
    // Same once-per-failure contract as exits below: a failure nobody heard
    // is live for its first listener, history for every later one.
    const replayed = entry.failedAnnounced;
    entry.failedAnnounced = true;
    sink.onSpawnError(entry.failed, replayed);
  } else if (entry.exited) {
    // A death nobody heard (it landed between detach and re-attach) is
    // announced to its first listener as LIVE; every later attach replays.
    const replayed = entry.exitAnnounced;
    entry.exitAnnounced = true;
    sink.onExit(entry.exited.code, replayed);
  }
  else if (entry.session) sink.onReady();
  // Already-launched session (re-attach): tell the view now, after the replay,
  // so it opens without the launch overlay instead of flashing it again.
  if (entry.launched) sink.onLaunched();
  return detach;
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
  // The state goes with the entry: a close is what makes an exit stop being
  // the pane's current truth, and anything still showing it must stop.
  states.delete(paneId);
  for (const listener of [...stateListeners]) listener();
  entry.closed = true;
  // The listener is NOT dropped: the view outlives the session it was showing,
  // and a restart hands the same terminal the next process.
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


/** Output kept for a one-off command's caller — enough to see the error. */
const ONCE_TAIL_CHARS = 600;

/** ANSI escapes and control bytes have no place on a status card. */
function plainText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

/**
 * Run a command to completion in a pane's slot, resolving to whether it
 * succeeded and the tail of what it printed.
 *
 * Here rather than in whatever needs it, because every line of it is registry
 * choreography over one pane's slot, and that slot has one owner. A caller
 * reaching for acquire/attach/close on its own would be a second answer to
 * "what process is behind this pane".
 *
 * The pane's own slot is the point: sessions are keyed by pane id, so closing
 * the pane mid-run kills this command's whole process group like any other
 * session — nothing to leak. The entry is released on completion, and the
 * pane's terminal (a different spawn identity) then takes the slot over
 * cleanly.
 *
 * A pane closed mid-run resolves NOT-ok rather than hanging. It used to hang
 * deliberately — "there is nobody left to report to" — but that stopped being
 * true: the caller that runs a workspace's setup command has cleanup of its
 * own to do afterwards (removing the worktree the closing user asked it to),
 * and a promise that never settles is a step that never runs. The command is
 * gone either way; what the caller learns is that it did not finish.
 */
export function runPaneOnce(
  paneId: string,
  spec: PaneSpawnSpec,
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    let tail = "";
    // Assigned below; the default covers a sink that settles before
    // `attachPane` returns (a replayed exit).
    let detach: () => void = () => {};
    const decoder = new TextDecoder();
    const settle = (ok: boolean, note: string) => {
      detach();
      unwatch();
      void closePane(paneId);
      resolve({ ok, tail: plainText(note).trim().slice(-ONCE_TAIL_CHARS) });
    };
    acquirePane(paneId, spec);
    // The slot emptying without an exit means the pane was closed under us.
    // `settle` would re-close a slot that is already gone, so this unwinds by
    // hand and answers directly.
    const unwatch = subscribeSessions(() => {
      if (paneSessionState(paneId).kind !== "none") return;
      detach();
      unwatch();
      resolve({ ok: false, tail: "the pane was closed" });
    });
    detach = attachPane(paneId, {
      onOutput: (bytes) => {
        tail = (tail + decoder.decode(bytes, { stream: true })).slice(
          -ONCE_TAIL_CHARS * 4,
        );
      },
      onExit: (code) =>
        code === 0
          ? settle(true, "")
          : settle(false, tail || `exit code ${code ?? "?"}`),
      onSpawnError: (message) => settle(false, message),
      onReady: () => {},
      // A one-off command runs behind a status card, not a terminal — its
      // first output drives no launch overlay.
      onLaunched: () => {},
    });
  });
}

/** Test hook: drop every entry, closing what's live. */
export function resetPtyManager(): void {
  for (const id of [...entries.keys()]) void closePane(id);
  // Listeners outlive the sessions they watch — deliberately, so a restart
  // keeps the same terminal attached — so nothing else drops them.
  sinks.clear();
}

function remember(entry: Entry, bytes: Uint8Array): void {
  entry.chunks.push(bytes);
  entry.buffered += bytes.byteLength;
  while (entry.buffered > MAX_BUFFER_BYTES && entry.chunks.length > 1) {
    entry.buffered -= entry.chunks[0].byteLength;
    entry.chunks.shift();
  }
}
