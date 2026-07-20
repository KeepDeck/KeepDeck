/** Shared text derivation for agent history parsers ([F8] browser). The
 * store WALK is per-CLI (formats differ); how message parts become text and
 * how a conversation gets a human title is not — and two private copies of
 * the title heuristic had already drifted apart. */

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
