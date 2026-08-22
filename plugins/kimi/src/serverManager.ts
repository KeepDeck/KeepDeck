/**
 * The LIFECYCLE of the Kimi setup server: spawning it, queueing operations
 * onto the one live instance, and tearing it down.
 *
 * Two other jobs used to live here and now don't, because each changes for
 * its own reason: the shell program the server is wrapped in
 * ([`./serverWrapper`]) and the reading of what the server printed
 * ([`./serverStartup`] — the endpoint, and the diagnostics when there is
 * none). What is left is the part that owns a PROCESS.
 */
import type {
  PluginSessionHandle,
  PluginSessions,
} from "@keepdeck/plugin-api";
import {
  MAX_STARTUP_OUTPUT,
  extractServerAccess,
  startupExitMessage,
  startupTimeoutMessage,
  type KimiServerAccess,
} from "./serverStartup";
import { setupServerWrapperScript } from "./serverWrapper";

const SERVER_START_TIMEOUT_MS = 15_000;

/** Re-exported for the manager's consumers: they ask this module for an
 * endpoint, so the shape of one reads as part of its surface — while the
 * definition stays beside the parser that produces it. */
export type { KimiServerAccess };

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
