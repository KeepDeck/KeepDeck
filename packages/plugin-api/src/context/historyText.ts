/** Shared text derivation for agent history parsers ([F8] browser). The
 * store WALK is per-CLI (formats differ); how message parts become text and
 * how a conversation gets a human title is not — and two private copies of
 * the title heuristic had already drifted apart. */

import { isJsonRecord } from "../json.ts";
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
    .map((part) => (isJsonRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Injected markup that must never NAME a conversation, whatever the CLI:
 * XML-ish tags, markdown instruction blobs, bracketed notices. Prose a CLI
 * injects in front of a conversation is that CLI's to declare
 * (`SessionDialect.titleSkipPrefixes`) — skipping it for every agent would
 * throw away a real first prompt that happens to start the same way. */
const MARKUP = /^[<#[]/;

/** A leading `/` is a slash COMMAND only when the whole message is one
 * token (`/prime`) — a pasted absolute path ("/path/to/file — do X") is a
 * real user message and a perfectly good title. */
const SLASH_COMMAND = /^\/\S*$/;

/** A human title: the first REAL user turn — skipping markup, slash
 * commands, and the preambles this agent's dialect declares. */
export function firstMeaningfulUserTurn(
  turns: readonly { role: string; text: string }[],
  skipPrefixes: readonly string[],
): string | undefined {
  const real = turns.find(
    (t) =>
      t.role === "user" &&
      !MARKUP.test(t.text) &&
      !skipPrefixes.some((prefix) => t.text.startsWith(prefix)) &&
      !SLASH_COMMAND.test(t.text.trim()) &&
      t.text.length > 1,
  );
  return real ? titleText(real.text) : undefined;
}
