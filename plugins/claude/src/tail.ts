/**
 * What one line of a claude transcript says about its pane, while the
 * transcript is still being written.
 *
 * The edge that lives here and nowhere else: a user interrupt. claude pushes
 * NO hook when the user presses Esc — the transcript is the only witness —
 * and the pane's whole idea of whether this agent is working rests on that
 * edge arriving. Hard steering also records the NEXT accepted prompt after
 * the old turn's cancellation, even though UserPromptSubmit ran before it.
 * Both records must travel together; reading only the abort ends new work.
 *
 * And a turn that goes on past its own end. `/goal` is a Stop hook of the
 * session's that blocks stopping until its condition holds: every Stop hook
 * runs, this plugin's reporter too, so the pane hears the turn end — and
 * then claude carries on in the same turn, with no prompt and no hook to say
 * so. Each time the check finds the goal not yet met it writes a
 * `goal_status` attachment; that line is the only witness that the turn
 * went on.
 *
 * This used to be the HOST's knowledge: it read `interruptedMessageId` out of
 * a claude record, decided the record meant an interrupt, minted a word for
 * it and routed on the word it had minted, while this plugin translated that
 * word back into the status union. What moved is the deciding.
 */
import {
  isJsonRecord,
  jsonl,
  parseInstant,
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
  "origin.kind"?: unknown;
  promptSource?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  /** An attachment's kind, and — on a `goal_status` — whether the check
   * found the goal met, or gave it up. */
  "attachment.type"?: unknown;
  "attachment.met"?: unknown;
  "attachment.failed"?: unknown;
}

/** Any JSON object: every field above is read as `unknown`. */
function isClaudeRecord(value: unknown): value is ClaudeRecord {
  return isJsonRecord(value);
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

export const claudeTail: SessionTailDialect<JsonlRequest, ClaudeRecord> = {
  format: jsonl(isClaudeRecord),

  /**
   * Lifecycle metadata only; prompt and assistant contents stay on disk.
   *
   * The reader applying this cannot tell an interrupt from a tool result: it
   * compares declared keys and copies selected metadata. What that buys is measured — a
   * claude transcript is mostly assistant records, which are the fat ones,
   * and a follower without this would carry a session's whole output to
   * somebody who wants a timestamp.
   *
   * `keep` names no message field, so a message cannot leave the transcript
   * through here. Not as a rule to remember — the field is simply never
   * copied.
   */
  watches: [{
    match: [{ key: "type", equals: "user" }, { key: "interruptedMessageId" }],
    keep: ["type", "interruptedMessageId", "timestamp", "isSidechain"],
    lane: "status",
  }, {
    match: [{ key: "type", equals: "user" }, { key: "origin.kind", equals: "human" }],
    keep: ["type", "timestamp", "origin.kind", "promptSource", "isMeta", "isSidechain"],
    lane: "status",
  }, {
    match: [{ key: "type", equals: "attachment" }, { key: "attachment.type", equals: "goal_status" }],
    keep: ["type", "timestamp", "attachment.type", "attachment.met", "attachment.failed", "isSidechain"],
    lane: "status",
  }],

  /** claude's own reporter names the transcript it writes, so there is no
   * path to reconstruct here — no project slug, no directory rule. A pane
   * whose agent has not reported yet has no store to follow, and that is an
   * ordinary state: it arrives on a later look. */
  follow: async (pane) => (pane.store ? { path: pane.store } : null),

  read: (record) => {
    const at = parseInstant(record.timestamp);
    if (at === null || record.isSidechain === true) return null;
    // The goal not met yet, and not given up: the turn that just ended goes
    // on. Met, or failed, it ends there — as the Stop already said.
    if (record.type === "attachment") {
      return record["attachment.type"] === "goal_status" &&
        record["attachment.met"] === false && record["attachment.failed"] !== true
        ? { kind: "turn-observed", at }
        : null;
    }
    if (record.type !== "user") return null;
    if (
      record["origin.kind"] === "human" && record.isMeta !== true &&
      (record.promptSource === "typed" || record.promptSource === "queued")
    ) return { kind: "turn-observed", at };
    const interrupted =
      typeof record.interruptedMessageId === "string" &&
      record.interruptedMessageId !== "";
    if (!interrupted) return null;
    // Unstamped is not reportable. The staleness guard compares this instant
    // against the turn it would end, so an interrupt with no honest time
    // cannot be placed — and placing it wrongly ends a turn that is running.
    return { kind: "interrupted", at, scope: "main" };
  },

  ignores: (record) =>
    typeof record.type === "string" && ORDINARY.has(record.type),
};
