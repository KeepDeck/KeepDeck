/* ---- Authoring helpers ----------------------------------------------- *
 * Small rules every plugin needs and none should write again: each one used
 * to live as a private copy in several plugins (and the host), held in step
 * by nothing. */

/** What was thrown, as one line for a log or an error message: an `Error`'s
 * message, a string as it is (IPC rejections are usually bare strings), and
 * anything else as JSON — a plain object read as `[object Object]` says
 * nothing. Plugin code and its teardown may throw ANYTHING. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** A string as ONE word of a POSIX shell command line: single-quoted, with an
 * embedded `'` closed, escaped and reopened (`'\''`). A path is the usual
 * cargo — KeepDeck.app can live under a directory with spaces. */
export function shellQuote(text: string): string {
  return `'${text.split("'").join(`'\\''`)}'`;
}

/** The SHA-256 of a string's UTF-8 bytes, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A timestamp string → epoch milliseconds, or null when it is not a string
 * or does not parse. Null rather than "now": a record read late and stamped
 * with receipt time would outrank the events it really came after. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
