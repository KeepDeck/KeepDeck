/**
 * A one-line rendering of a caught unknown. Plugin code and its teardown may
 * throw ANYTHING — a bare string, an `Error`, a plain object — and every host
 * catch needs one stable sentence to record and to surface as a `failed`
 * reason. Mirrors the app's own `describeError` (`src/ipc/log.ts`) rather than
 * importing it: the plugin core depends only on the contract package and its
 * own ports, never on the IPC/Tauri layer.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
