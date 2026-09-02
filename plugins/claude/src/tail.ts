/**
 * What one line of a claude transcript says about its pane, while the
 * transcript is still being written.
 *
 * The edge that lives here and nowhere else: a user interrupt. claude pushes
 * NO hook when the user presses Esc — the transcript is the only witness —
 * and the pane's whole idea of whether this agent is working rests on that
 * edge arriving. Everything else about the turn comes through the reporter's
 * hooks, which is why this dialect reports one kind of event and passes over
 * fifteen kinds of record.
 *
 * This used to be the HOST's knowledge: it read `interruptedMessageId` out of
 * a claude record, decided the record meant an interrupt, minted a word for
 * it and routed on the word it had minted, while this plugin translated that
 * word back into the status union. What moved is the deciding.
 */
import {
  jsonl,
  type JsonlRequest,
  type SessionTailDialect,
} from "@keepdeck/plugin-api";

/** The fields of a transcript line this dialect reads. Everything else on a
 * line — the message, its content, its tool calls — is deliberately absent:
 * a shape with nowhere to put a conversation cannot leak one. */
interface ClaudeRecord {
  type?: unknown;
  /** The id of the assistant message the user cut short. STRUCTURED, and the
   * reason this is keyed on a field rather than on the "[Request
   * interrupted…]" text: an assistant merely quoting that phrase must not
   * end its own turn. */
  interruptedMessageId?: unknown;
  timestamp?: unknown;
}

/**
 * Line kinds claude writes that say nothing about the turn.
 *
 * Taken from twelve of the largest transcripts on a real machine, where they
 * account for every line that is not an interrupt marker. The list exists so
 * that a SIXTEENTH kind arriving is visible: today an unrecognised line is
 * indistinguishable from an ordinary one, and that is exactly how a format
 * that moved goes unnoticed until somebody reports a pane stuck on
 * "working". Naming what we skip is what makes the unnamed loud.
 *
 * `user` and `assistant` are in here too: an ordinary user line is one this
 * dialect looked at and had nothing to say about, which is different from
 * one it did not recognise.
 */
const ORDINARY = new Set([
  "assistant",
  "user",
  "attachment",
  "last-prompt",
  "mode",
  "permission-mode",
  "ai-title",
  "system",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "atis-latch",
  "agent-name",
  "bridge-session",
  "frame-link",
  "cost-state",
  "summary",
]);

/** The line's own instant. Claude stamps RFC 3339 with a `Z`; anything else
 * is treated as unstamped rather than guessed at, because a marker read up
 * to a poll interval late and stamped with receipt time would outrank the
 * turn it belongs behind. */
function instantOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export const claudeTail: SessionTailDialect<JsonlRequest, ClaudeRecord> = {
  format: jsonl<ClaudeRecord>(),

  /**
   * The one shape worth carrying out of a claude transcript, and the three
   * fields worth carrying with it.
   *
   * The reader applying this cannot tell an interrupt from a tool result: it
   * compares two keys and copies three. What that buys is measured — a
   * claude transcript is mostly assistant records, which are the fat ones,
   * and a follower without this would carry a session's whole output to
   * somebody who wants a timestamp.
   *
   * `keep` names no message field, so a message cannot leave the transcript
   * through here. Not as a rule to remember — the field is simply never
   * copied.
   */
  watch: {
    match: [{ key: "type", equals: "user" }, { key: "interruptedMessageId" }],
    keep: ["type", "interruptedMessageId", "timestamp"],
  },

  /** claude's own reporter names the transcript it writes, so there is no
   * path to reconstruct here — no project slug, no directory rule. A pane
   * whose agent has not reported yet has no store to follow, and that is an
   * ordinary state: it arrives on a later look. */
  follow: async (pane) => (pane.store ? { path: pane.store } : null),

  read: (record) => {
    if (record.type !== "user") return null;
    const interrupted =
      typeof record.interruptedMessageId === "string" &&
      record.interruptedMessageId !== "";
    if (!interrupted) return null;
    const at = instantOf(record.timestamp);
    // Unstamped is not reportable. The staleness guard compares this instant
    // against the turn it would end, so an interrupt with no honest time
    // cannot be placed — and placing it wrongly ends a turn that is running.
    return at === null ? null : { kind: "interrupted", at };
  },

  ignores: (record) =>
    typeof record.type === "string" && ORDINARY.has(record.type),
};
