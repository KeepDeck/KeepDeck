import type {
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";

const SERVER_START_TIMEOUT_MS = 15_000;
const MAX_STARTUP_OUTPUT = 32_768;

/** How often the spawn wrapper checks that its parent (the KeepDeck process)
 * is still alive. See setupServerWrapperScript's docblock for the design. */
const WATCHDOG_POLL_SECONDS = 5;

export interface KimiServerAccess {
  origin: string;
  token: string;
}

export interface KimiServerManager {
  run<T>(
    operation: (
      access: KimiServerAccess,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T>;
  dispose(): Promise<void>;
}

interface QueuedOperation {
  execute(
    access: KimiServerAccess,
    signal: AbortSignal,
  ): Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

interface RunningServer {
  access: KimiServerAccess;
  handle: PluginSessionHandle;
  abort: AbortController;
}

/** Owns every setup-server process for one activated Kimi plugin. Operations
 * queue behind a single lazy foreground server and share it sequentially; the
 * server closes as soon as the queue drains. */
export function createKimiServerManager(
  sessions: PluginSessions,
): KimiServerManager {
  const queue: QueuedOperation[] = [];
  const closing = new WeakMap<PluginSessionHandle, Promise<void>>();
  let drainPromise: Promise<void> | null = null;
  let activeHandle: PluginSessionHandle | null = null;
  let activeAbort: AbortController | null = null;
  let disposed = false;

  const closeHandle = (handle: PluginSessionHandle): Promise<void> => {
    const existing = closing.get(handle);
    if (existing) return existing;
    const close = handle.close().catch(() => {});
    closing.set(handle, close);
    return close;
  };

  const rejectQueue = (reason: unknown) => {
    for (const operation of queue.splice(0)) operation.reject(reason);
  };

  const schedule = () => {
    if (disposed || drainPromise || queue.length === 0) return;
    const cycle = drain();
    drainPromise = cycle;
    void cycle.finally(() => {
      if (drainPromise === cycle) drainPromise = null;
      if (!disposed && queue.length > 0) schedule();
    });
  };

  async function drain(): Promise<void> {
    let server: RunningServer;
    try {
      server = await startServer();
    } catch (error) {
      rejectQueue(error);
      return;
    }

    try {
      while (!disposed) {
        const operation = queue.shift();
        if (!operation) break;
        try {
          operation.resolve(
            await operation.execute(server.access, server.abort.signal),
          );
        } catch (error) {
          operation.reject(error);
        }
      }
    } finally {
      await stopServer(server);
    }
  }

  async function startServer(): Promise<RunningServer> {
    if (disposed) throw disposedError();
    const abort = new AbortController();
    activeAbort = abort;
    const decoder = new TextDecoder();
    let startupOutput = "";
    let readySettled = false;
    let resolveReady!: (access: KimiServerAccess) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<KimiServerAccess>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});
    const settleReady = (result: KimiServerAccess | Error) => {
      if (readySettled) return;
      readySettled = true;
      if (result instanceof Error) rejectReady(result);
      else resolveReady(result);
    };

    let abandoned = false;
    let spawn: Promise<PluginSessionHandle>;
    try {
      spawn = sessions.spawn(
        {
          command: "/bin/sh",
          // The server runs under a tiny watchdog wrapper (see
          // setupServerWrapperScript for the script and its design):
          //
          // - `kimi web` replaced `kimi server run` (removed in Kimi Code 0.28).
          //   `--no-open` suppresses the browser it would otherwise launch;
          //   `--host 127.0.0.1` keeps the bind loopback-only — required for
          //   `--debug-endpoints`, which mounts the `/api/v1/debug/*` RPC
          //   surface (the only plugin-management API left in 0.29; gated to
          //   loopback binds by Kimi itself). `--log-level silent` gates only
          //   request logs — the startup banner and any failure notice still
          //   print, so both extractServerAccess and the "It reported:"
          //   diagnostic below keep seeing the server's own output.
          // - `--port 0` lets Kimi bind a free ephemeral port and print the
          //   real one in the banner: a fixed port cannot collide with a
          //   second KeepDeck instance (dev next to prod) or a stray server.
          args: ["-c", setupServerWrapperScript()],
          cols: 80,
          rows: 24,
        },
        (event) => {
          if (event.type === "output") {
            startupOutput += decoder.decode(event.bytes, { stream: true });
            if (startupOutput.length > MAX_STARTUP_OUTPUT) {
              startupOutput = startupOutput.slice(-MAX_STARTUP_OUTPUT);
            }
            const access = extractServerAccess(startupOutput);
            if (access) settleReady(access);
            return;
          }
          settleReady(
            new Error(startupExitMessage(event.code, startupOutput)),
          );
        },
      );
    } catch (error) {
      if (activeAbort === abort) activeAbort = null;
      throw error;
    }
    void spawn.then(
      (handle) => {
        if (abandoned || disposed || abort.signal.aborted) {
          void closeHandle(handle);
        }
      },
      () => {},
    );

    let handle: PluginSessionHandle;
    try {
      handle = await withTimeout(
        spawn,
        SERVER_START_TIMEOUT_MS,
        "Timed out starting the Kimi setup server.",
      );
    } catch (error) {
      abandoned = true;
      abort.abort();
      if (activeAbort === abort) activeAbort = null;
      throw error;
    }

    if (disposed || abort.signal.aborted) {
      abandoned = true;
      await closeHandle(handle);
      if (activeAbort === abort) activeAbort = null;
      throw disposedError();
    }

    activeHandle = handle;
    try {
      const access = await withTimeout(
        ready,
        SERVER_START_TIMEOUT_MS,
        () => startupTimeoutMessage(startupOutput),
      );
      if (abort.signal.aborted) throw disposedError();
      return { access, handle, abort };
    } catch (error) {
      abort.abort();
      if (activeHandle === handle) activeHandle = null;
      if (activeAbort === abort) activeAbort = null;
      await closeHandle(handle);
      throw error;
    }
  }

  async function stopServer(server: RunningServer): Promise<void> {
    server.abort.abort();
    if (activeHandle === server.handle) activeHandle = null;
    if (activeAbort === server.abort) activeAbort = null;
    await closeHandle(server.handle);
  }

  return {
    run<T>(
      operation: (
        access: KimiServerAccess,
        signal: AbortSignal,
      ) => Promise<T>,
    ): Promise<T> {
      if (disposed) return Promise.reject(disposedError());
      return new Promise<T>((resolve, reject) => {
        queue.push({
          execute: operation,
          resolve: (value) => resolve(value as T),
          reject,
        });
        schedule();
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const error = disposedError();
      rejectQueue(error);
      activeAbort?.abort();
      if (activeHandle) await closeHandle(activeHandle);
      await drainPromise;
    },
  };
}

/** The spawn wrapper script. Exported (not inline) so the test suite can
 * syntax-check it with `sh -n` instead of only asserting substrings.
 *
 * Design:
 * - The watcher subshell polls its parent (the KeepDeck process) and kills
 *   the server when the parent is gone — `kimi web` survives SIGHUP, so a
 *   hard host crash (SIGKILL, power loss) would otherwise orphan a live
 *   server with an unrecoverable token. `kill -0` checks pid EXISTENCE, so
 *   the poll also compares the parent's start time (`ps -o lstart=`): a
 *   recycled pid fails the identity check. A failed `ps` read skips the
 *   comparison rather than risking a spurious kill.
 * - A PTY-master close delivers SIGHUP to the foreground process group, so
 *   the wrapper traps HUP to stay alive long enough to finish the teardown;
 *   the TERM→KILL escalation mirrors the PTY close contract because the
 *   server can take seconds to honor a bare TERM.
 * - The watcher's own `sleep` children are reaped via TERM/EXIT traps —
 *   otherwise a killed watcher leaves a sleep holding the PTY slave open,
 *   delaying EOF (and the exit event) past the PTY's kill grace.
 * - The main shell `wait`s on the server and re-exits with its status, so a
 *   server that dies on its own produces the honest "exited before it
 *   became ready" event instead of a misleading startup timeout. The
 *   graceful path needs no watchdog: closing the session signals the whole
 *   process group. */
export function setupServerWrapperScript(): string {
  return `trap "" HUP
parent=$PPID
started=$(ps -o lstart= -p "$parent" 2>/dev/null)
kimi web --no-open --host 127.0.0.1 --port 0 --log-level silent --debug-endpoints &
child=$!
(
  slp=
  trap 'kill "$slp" 2>/dev/null' EXIT
  trap 'exit 0' TERM
  while kill -0 "$parent" 2>/dev/null; do
    now=$(ps -o lstart= -p "$parent" 2>/dev/null)
    [ -n "$started" ] && [ -n "$now" ] && [ "$now" != "$started" ] && break
    sleep ${WATCHDOG_POLL_SECONDS} &
    slp=$!
    wait "$slp" 2>/dev/null
  done
  kill "$child" 2>/dev/null
  sleep 3 &
  slp=$!
  wait "$slp" 2>/dev/null
  kill -9 "$child" 2>/dev/null
) &
watcher=$!
wait "$child" 2>/dev/null
code=$?
kill "$watcher" 2>/dev/null
exit "$code"`;
}

/** Parse the authenticated loopback endpoint from the server's startup
 * banner. The port is whatever ephemeral port `--port 0` bound, so only the
 * host and the presence of a token are validated. */
export function extractServerAccess(
  output: string,
): KimiServerAccess | null {
  const plain = stripTerminalControls(output);
  const match = plain.match(
    /http:\/\/127\.0\.0\.1:\d+\/(?:#token=[^\s]+)?/,
  );
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.hostname !== "127.0.0.1") {
      return null;
    }
    const token = url.hash.startsWith("#token=")
      ? decodeURIComponent(url.hash.slice("#token=".length))
      : "";
    return token ? { origin: url.origin, token } : null;
  } catch {
    return null;
  }
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/** A short, single-line head of what the setup server actually printed, with
 * terminal control sequences and blank lines removed. Empty when it said
 * nothing. This is the honest diagnostic — a Kimi deprecation notice or a bind
 * error appears at the START of the output, so on long output we keep the head
 * (with a trailing `…`), not the tail, to preserve the line that names the
 * failure. */
export function describeStartupOutput(raw: string): string {
  const text = stripTerminalControls(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  if (!text) return "";
  const limit = 300;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Single source for the " It reported: …" suffix — appends the server's own
 * captured output to a failure message whenever it printed anything. */
function withReportedOutput(base: string, rawOutput: string): string {
  const detail = describeStartupOutput(rawOutput);
  return detail ? `${base} It reported: ${detail}` : base;
}

/** The setup-server process died before reporting its address; the server's
 * own output is the real reason. */
function startupExitMessage(
  code: number | null,
  rawOutput: string,
): string {
  const codeText = code === null ? "" : ` (code ${code})`;
  return withReportedOutput(
    `Kimi setup server exited before it became ready${codeText}.`,
    rawOutput,
  );
}

/** The setup server stayed up but never printed a parseable address in time —
 * most likely Kimi changed its startup banner. */
function startupTimeoutMessage(rawOutput: string): string {
  return withReportedOutput(
    "Timed out waiting for the Kimi setup server to report its address. Kimi may have changed its startup banner.",
    rawOutput,
  );
}

function disposedError(): Error {
  return new Error(
    "Kimi setup was cancelled because the KeepDeck plugin stopped.",
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string | (() => string),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(typeof message === "function" ? message() : message),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
