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
import type { PluginSessionHandle, PluginSessions } from "@keepdeck/plugin-api";

/** What running a command needs from the host: its PTY sessions. */
export interface ExecPorts {
  services: { sessions: Pick<PluginSessions, "spawn"> };
}

/** One finished command: what it printed and how it exited. */
export interface CommandRun {
  /** stdout and stderr together, as the PTY wrote them (`\r\n`, colours). */
  text: string;
  /** null when the PTY could not report one. */
  code: number | null;
}

/** Hard cap on one export/import. They are fast (no model/MCP), so this only
 * catches a genuinely stuck process — without it a hung opencode would leave
 * the fork Promise (and the whole fork chain) pending forever. */
const RUN_TIMEOUT_MS = 60_000;

/** A command stopped after its timeout whose end could not be confirmed: it
 * may still be running, and writing. Nothing it may touch is cleaned up
 * behind it — that would race its last writes. */
export class StillRunning extends Error {}

/** Run `opencode <args>` to completion on a host PTY, returning its full
 * output text and exit code. A non-TUI command (export/import) writes plain
 * text; the PTY only maps `\n`→`\r\n` (harmless JSON whitespace). Rejects on a
 * spawn failure, or once the process is over after `RUN_TIMEOUT_MS` — its
 * stop awaited to the end, a spawn still on its way included, so the caller
 * cleans up only after it. A stop that could not be confirmed rejects with
 * [`StillRunning`]. */
export async function runOpencode(
  ctx: ExecPorts,
  args: readonly string[],
  cwd?: string,
): Promise<CommandRun> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const spawned: Promise<PluginSessionHandle> = ctx.services.sessions.spawn(
      { command: "opencode", args: [...args], ...(cwd ? { cwd } : {}), cols: 120, rows: 40 },
      (event) => {
        if (event.type === "output") chunks.push(event.bytes);
        else finish(() => resolve({ text: decode(chunks), code: event.code }));
      },
    );
    const named = `opencode ${args.slice(0, 2).join(" ")}`;
    const timer = setTimeout(() => {
      // A settled run has nothing to stop — its exit beat the timer.
      if (settled) return;
      // The process — one whose spawn is still on its way too — is stopped
      // and its end awaited BEFORE the rejection: the caller then removes
      // what this very process may still be reading or writing.
      void spawned.then(
        (handle) =>
          handle.close().then(
            () => finish(() => reject(new Error(`${named} timed out after ${RUN_TIMEOUT_MS}ms`))),
            (cause: unknown) =>
              finish(() =>
                reject(new StillRunning(`${named} timed out, and its stop could not be confirmed (${String(cause)})`)),
              ),
          ),
        // It never started: there is nothing running to wait for.
        () => finish(() => reject(new Error(`${named} timed out after ${RUN_TIMEOUT_MS}ms`))),
      );
    }, RUN_TIMEOUT_MS);
    spawned.catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
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
export const tail = (text: string): string => plainText(text).trim().slice(-200);

/** A command's output as words: without the terminal's colour codes (1.x
 * prints its `Error:` in colour) and its `\r`. A verdict read from the raw
 * bytes would match only for as long as no colour lands inside the phrase. */
export const plainText = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");

/** The output's lines, as words. */
export const linesOf = (run: CommandRun): string[] =>
  plainText(run.text).split("\n").map((line) => line.trim());

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
