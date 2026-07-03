import * as plugin from "@tauri-apps/plugin-log";

/** The webview's door into the shared log pipeline: every call lands in the
 *  same per-run file the Rust side writes (console output is invisible in a
 *  bundled app). Fire-and-forget and swallow-everything by design — logging
 *  must never break the app, including outside Tauri (vitest, plain vite). */

/** `web:<module>` — where in the webview a line came from. */
export type LogTarget = `web:${string}`;

type Sink = (message: string) => Promise<void>;

function ship(sink: Sink, target: LogTarget, message: string): void {
  try {
    void sink(`[${target}] ${message}`).catch(() => {});
  } catch {
    // No Tauri host (tests, plain vite) — drop the line.
  }
}

export const log = {
  error: (target: LogTarget, message: string): void =>
    ship(plugin.error, target, message),
  warn: (target: LogTarget, message: string): void =>
    ship(plugin.warn, target, message),
  info: (target: LogTarget, message: string): void =>
    ship(plugin.info, target, message),
  debug: (target: LogTarget, message: string): void =>
    ship(plugin.debug, target, message),
};

/** A one-line rendering of a caught unknown — IPC rejections are usually bare
 *  strings, everything else gets its message or a JSON dump. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** Wire the webview's last-resort surfaces into the log: uncaught errors and
 *  unhandled promise rejections. In dev, also mirror the Rust side's log
 *  stream into the devtools console. Call once at boot. */
export function initLogging(): void {
  window.addEventListener("error", (event) => {
    log.error("web:window", `uncaught: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    log.error("web:window", `unhandled rejection: ${describeError(event.reason)}`);
  });
  if (import.meta.env.DEV) {
    try {
      void plugin.attachConsole().catch(() => {});
    } catch {
      // No Tauri host — nothing to mirror.
    }
  }
}
