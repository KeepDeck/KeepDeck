/** Shared text derivation for agent history parsers ([F8] browser). The
 * store WALK is per-CLI (formats differ); how message parts become text and
 * how a conversation gets a human title is not — and two private copies of
 * the title heuristic had already drifted apart. */

import type { Shortfall } from "./agents.ts";

/** What a capped file read fell short by, in the file's own measure.
 *
 * Every file-backed plugin does the same three steps — ask for at most N
 * bytes, notice the flag, say how much of how much — so it is written once
 * rather than three times. `undefined` when nothing was missed: an absent
 * shortfall already spells that, and a second spelling would drift.
 *
 * Both numbers come FROM THE READ, never from the request. The host clamps a
 * `maxBytes` to its own ceiling, so a plugin computing the length from what
 * it asked for would overstate it precisely when it asked for too much — a
 * false number in the field that exists to keep numbers honest. */
export function shortfallOfRead(file: {
  size: number;
  truncated: boolean;
  readBytes: number;
}): Shortfall[] | undefined {
  if (!file.truncated) return undefined;
  return [{ kind: "bytes", size: file.size, readBytes: file.readBytes }];
}

/** The text of a content-parts array, whatever the CLI's part dialect:
 * every part carrying a string `text` contributes; tool calls/results and
 * other non-text parts are silently skipped. */
export function textFromParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Injected preambles that must never NAME a conversation: XML-ish tags,
 * markdown instruction blobs, bracketed notices, skill bootstraps, claude's
 * local-command caveat. */
const PREAMBLE = /^([<#[]|Base directory for this skill:|Caveat:)/;

/** A leading `/` is a slash COMMAND only when the whole message is one
 * token (`/prime`) — a pasted absolute path ("/path/to/file — do X") is a
 * real user message and a perfectly good title. */
const SLASH_COMMAND = /^\/\S*$/;

/** A human title: the first REAL user turn — skipping preambles. */
export function firstMeaningfulUserTurn(
  turns: readonly { role: string; text: string }[],
): string | undefined {
  const real = turns.find(
    (t) =>
      t.role === "user" &&
      !PREAMBLE.test(t.text) &&
      !SLASH_COMMAND.test(t.text.trim()) &&
      t.text.length > 1,
  );
  return real ? real.text.slice(0, 120) : undefined;
}
