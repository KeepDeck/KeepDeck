/** How often the IPC health line is written. Rare enough to cost nothing,
 * often enough that a registry growing by thousands an hour shows a slope
 * within one sitting. */
export const IPC_HEALTH_EVERY_MS = 5 * 60_000;

export interface IpcHealthLogDeps {
  /** Callbacks the IPC glue still holds; `null` when there is no glue. */
  pendingCallbacks(): number | null;
  /** Seconds since the page loaded — a growing count read against uptime is
   * what separates a leak from a busy minute. */
  uptimeSeconds(): number;
  info(message: string): void;
}

/** Writes the IPC callback registry's size to the app log on a fixed beat.
 *
 * The webview's live JS heap grows by ~20 objects per IPC call that never
 * comes back, and an invoke without an answer leaves exactly that behind in
 * the glue's registry. This line is how the running app itself says whether
 * that is what is happening — no tool attached from outside. Silent when
 * there is no glue to read. */
export function createIpcHealthLog(
  deps: IpcHealthLogDeps,
  everyMs = IPC_HEALTH_EVERY_MS,
): { dispose(): void } {
  const tick = setInterval(() => {
    const pending = deps.pendingCallbacks();
    if (pending === null) return;
    deps.info(
      `ipc callbacks pending=${pending} uptime=${Math.round(deps.uptimeSeconds())}s`,
    );
  }, everyMs);
  return {
    dispose() {
      clearInterval(tick);
    },
  };
}
