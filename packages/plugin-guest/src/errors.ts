/**
 * A one-line rendering of a caught unknown. A plugin's `activate` may throw
 * ANYTHING — an `Error`, a bare string, a plain object — and the guest turns
 * that into a `failed` reason the host records. Mirrors the app's own
 * `describeError` (and `src/plugins/host/errors.ts`) rather than importing it:
 * the guest runtime depends only on the contract and the protocol, never on host
 * internals.
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
