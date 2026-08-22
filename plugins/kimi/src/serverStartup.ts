/**
 * What the Kimi setup server PRINTED, and what we make of it.
 *
 * Two jobs, one subject: the startup banner is where the authenticated
 * endpoint comes from, and — when there is no endpoint — it is the only
 * honest account of why. Both readings strip the same terminal control
 * sequences and share the same cap, which is why they belong together and
 * apart from the process lifecycle that merely captures the bytes.
 */

/** The authenticated loopback endpoint the setup server reports. */
export interface KimiServerAccess {
  origin: string;
  token: string;
}

/** How much of the server's output is kept for parsing and diagnostics. A
 * long-running server can print more than the address; only the tail within
 * this cap is retained. */
export const MAX_STARTUP_OUTPUT = 32_768;

/** Parse the authenticated loopback endpoint from the server's startup
 * banner. The port is whatever ephemeral port `--port 0` bound, so only the
 * host and the presence of a token are validated. */
export function extractServerAccess(
  output: string,
): KimiServerAccess | null {
  const plain = stripTerminalControls(output);
  // The token is REQUIRED in the pattern: a match without one is discarded
  // below anyway, and a non-global `match` stops at the first hit — so an
  // optional group let a bare loopback URL printed ahead of the tokenized
  // one eat the only match and report the server as never ready.
  const match = plain.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+/);
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
export function startupExitMessage(
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
export function startupTimeoutMessage(rawOutput: string): string {
  return withReportedOutput(
    "Timed out waiting for the Kimi setup server to report its address. Kimi may have changed its startup banner.",
    rawOutput,
  );
}
