/** Shared text derivation for agent history parsers ([F8] browser). The
 * store WALK is per-CLI (formats differ); how message parts become text and
 * how a conversation gets a human title is not — and two private copies of
 * the title heuristic had already drifted apart. */

import type { AgentTranscriptEntry } from "./agents.ts";

/** How much of a title the index keeps. */
const TITLE_LENGTH = 120;

/** A conversation's title as the index holds it — the store's own or one
 * derived from the first turn alike. */
export const titleText = (title: string): string => title.slice(0, TITLE_LENGTH);

/** A transcript role from a store's role word: a user or an assistant, and
 * anything else — a tool, a system notice, a word a newer CLI adds — other. */
export function transcriptRole(role: unknown): AgentTranscriptEntry["role"] {
  return role === "user" || role === "assistant" ? role : "other";
}

/** A string field's text with surrounding whitespace removed, or undefined
 * when it is not a string or holds nothing but whitespace — the read for a
 * cwd or a summary a store may write blank. */
export function trimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
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
  return real ? titleText(real.text) : undefined;
}
