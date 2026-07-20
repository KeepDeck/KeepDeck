import type {
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";

const SERVER_START_TIMEOUT_MS = 15_000;
const MAX_STARTUP_OUTPUT = 32_768;

/** One plugin-local port, outside core's 17000..18999 Run range, is also an
 * OS-level singleton guard. We deliberately do not probe or fall back: a
 * second or foreign listener must make setup fail visibly instead of silently
 * creating another Kimi server. */
export const KIMI_SETUP_SERVER_PORT = 19_120;

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
  port = KIMI_SETUP_SERVER_PORT,
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
          command: "kimi",
          // `kimi server run` was removed in Kimi Code 0.28; `kimi web` is its
          // replacement and runs the same authenticated loopback server in the
          // foreground. `--no-open` suppresses the browser it would otherwise
          // launch; the `http://127.0.0.1:<port>/#token=…` banner extractServerAccess
          // parses is unchanged. `--host 127.0.0.1` keeps the bind loopback-only.
          args: [
            "web",
            "--no-open",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--log-level",
            "silent",
          ],
          cols: 80,
          rows: 24,
        },
        (event) => {
          if (event.type === "output") {
            startupOutput += decoder.decode(event.bytes, { stream: true });
            if (startupOutput.length > MAX_STARTUP_OUTPUT) {
              startupOutput = startupOutput.slice(-MAX_STARTUP_OUTPUT);
            }
            const access = extractServerAccess(startupOutput, port);
            if (access) settleReady(access);
            return;
          }
          settleReady(
            new Error(startupExitMessage(port, event.code, startupOutput)),
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
        `Timed out starting the Kimi setup server on 127.0.0.1:${port}.`,
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
        () => startupTimeoutMessage(port, startupOutput),
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

/** Parse only the exact authenticated endpoint requested by this manager. */
export function extractServerAccess(
  output: string,
  expectedPort = KIMI_SETUP_SERVER_PORT,
): KimiServerAccess | null {
  const plain = stripTerminalControls(output);
  const match = plain.match(
    /http:\/\/127\.0\.0\.1:\d+\/(?:#token=[^\s]+)?/,
  );
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== String(expectedPort)
    ) {
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

/** A short, single-line tail of what the setup server actually printed, with
 * terminal control sequences and blank lines removed. Empty when it said
 * nothing. This is the honest diagnostic — e.g. a Kimi deprecation notice or a
 * bind error — instead of guessing at the cause. */
function describeStartupOutput(raw: string): string {
  const text = stripTerminalControls(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  if (!text) return "";
  const limit = 300;
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/** The setup-server process died before reporting its address. A busy port
 * makes `kimi web` hang (→ timeout), not exit, so we never blame the port here;
 * the server's own output is the real reason. */
function startupExitMessage(
  port: number,
  code: number | null,
  rawOutput: string,
): string {
  const codeText = code === null ? "" : ` (code ${code})`;
  const detail = describeStartupOutput(rawOutput);
  const base =
    `Kimi setup server exited before it became ready on 127.0.0.1:${port}${codeText}.`;
  return detail ? `${base} It reported: ${detail}` : base;
}

/** The setup server stayed up but never printed a parseable address in time.
 * This is where a genuinely busy port lands (`kimi web` hangs on the bind), so
 * the port hint belongs here — alongside the banner-changed possibility. */
function startupTimeoutMessage(port: number, rawOutput: string): string {
  const detail = describeStartupOutput(rawOutput);
  const base =
    `Timed out waiting for the Kimi setup server on 127.0.0.1:${port} to report its address. The port may already be in use, or Kimi changed its startup banner.`;
  return detail ? `${base} It reported: ${detail}` : base;
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
