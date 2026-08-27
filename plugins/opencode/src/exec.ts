/**
 * Running an opencode command and reading back what it printed.
 *
 * A plugin runs in the frontend with no filesystem and no spawn of its own, so
 * a command goes out through the host's PTY service and comes back as bytes.
 * That is the whole of this file: a timeout, a decoder, and a reader for the
 * one text protocol `export` speaks. It knows nothing about forks, sessions or
 * what a failure should mean to the user.
 *
 * Kept apart from the recipe that uses it because the two change for different
 * reasons: this changes when the host's exec contract does, or when opencode
 * prints something new around its payload; the recipe changes when the fork
 * itself does. Half of [`fork.ts`] used to be this, which put hand-rolled
 * timers and a bracket scanner in the same file as the prose a user reads on a
 * badge — and made the scanner untestable without spawning something.
 */
import type { PluginContext, PluginSessionHandle } from "@keepdeck/plugin-api";

/** Hard cap on one export/import. They are fast (no model/MCP), so this only
 * catches a genuinely stuck process — without it a hung opencode would leave
 * the fork Promise (and the whole fork chain) pending forever. */
const RUN_TIMEOUT_MS = 60_000;

/** Run `opencode <args>` to completion on a host PTY, returning its full
 * output text and exit code. A non-TUI command (export/import) writes plain
 * text; the PTY only maps `\n`→`\r\n` (harmless JSON whitespace). Rejects on a
 * spawn failure or if the process does not exit within `RUN_TIMEOUT_MS`. */
export async function runOpencode(
  ctx: PluginContext,
  args: string[],
  cwd?: string,
): Promise<{ text: string; code: number | null }> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    let handle: PluginSessionHandle | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      // A settled run has nothing to kill — its exit beat the timer.
      if (settled) return;
      // Settle the kill BEFORE rejecting: the caller's finally overwrites
      // the scratch file this very process may still be reading, so the
      // rejection must not outrun the close.
      const killed = handle?.close().catch(() => {}) ?? Promise.resolve();
      void killed.then(() =>
        finish(() =>
          reject(new Error(`opencode ${args[0] ?? ""} timed out after ${RUN_TIMEOUT_MS}ms`)),
        ),
      );
    }, RUN_TIMEOUT_MS);
    ctx.services.sessions
      .spawn(
        { command: "opencode", args, ...(cwd ? { cwd } : {}), cols: 120, rows: 40 },
        (event) => {
          if (event.type === "output") chunks.push(event.bytes);
          else finish(() => resolve({ text: decode(chunks), code: event.code }));
        },
      )
      .then((h) => {
        handle = h;
        // The timeout already fired while spawn was in flight — kill the
        // process we just started so it doesn't leak.
        if (settled) void h.close().catch(() => {});
      })
      .catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

function decode(chunks: Uint8Array[]): string {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(merged);
}

/** Last chars of a command's output, for an error message. */
export const tail = (text: string): string => text.trim().slice(-200);

/** The JSON object out of `opencode export`'s output. A `Exporting session:`
 * line rides ahead of the payload on the PTY, and opencode MAY print a trailing
 * line after it (stdout is a TTY), so scan from the first `{` to its MATCHING
 * `}` — string-aware — rather than a naive first-`{`..last-`}` slice. */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("opencode export produced no JSON payload");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("opencode export JSON was truncated or unbalanced");
}
