import {
  actorFromFields,
  asNonEmptyString,
  decodeStatusPayload,
  frameTeammateMail,
  isJsonRecord,
  type AgentStatusEvent,
  type EventAttribution,
  type MailChannel,
  type MailReplyInput,
  type MailReplyRenderer,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";
import { codexRecords } from "./tail";
import { codexQuestionStatus } from "./questions";
import { releasedSince } from "./version";

/** The teammate framing both events below carry, worded once for every CLI
 * in [`frameTeammateMail`]. */
const teammateText = ({ messages, waiting }: MailReplyInput): string =>
  frameTeammateMail(messages, waiting);

/**
 * The release at which codex replaced its hook-output schema.
 *
 * Read out of the shipped 0.147 binary's own wire structs
 * (`StopCommandOutputWire`, `UserPromptSubmitHookSpecificOutputWire`): the
 * shared output fields are `decision` / `reason` / `hookSpecificOutput`, the
 * hook-specific ones `hookEventName` / `additionalContext`, camelCase
 * throughout — the same schema claude uses. The four names the older
 * releases wanted (`should_block`, `block_reason`, `continuation_fragments`,
 * `additional_context`) appear NOWHERE in that binary.
 */
const HOOK_SCHEMA_CHANGED_AT: readonly number[] = [0, 147, 0];

/**
 * Whether this install wants the pre-0.147 schema.
 *
 * An unknown version answers FALSE — the current schema is the one that
 * works on every install anyone is running today, and a probe can come back
 * empty for reasons that have nothing to do with the release. Guessing "old"
 * on no evidence would break the working case to serve a retired one.
 */
function wantsLegacySchema(cliVersion: string | null): boolean {
  return releasedSince(cliVersion, HOOK_SCHEMA_CHANGED_AT) === false;
}

/**
 * ⚠️ DELETE ME once 0.147 is the floor we support.
 *
 * The schema codex accepted before 0.147: `should_block` keeps the turn
 * alive and the continuation fragment is what the model reads next;
 * `additional_context` spills into the prompt. Every one of these names is
 * gone from the current binary, so this path exists only for someone who has
 * not updated. When the old releases stop mattering, this function, its
 * branch in [`renderCodexMail`], and [`HOOK_SCHEMA_CHANGED_AT`] all go
 * together and the renderer becomes a plain switch again.
 */
function renderLegacyCodexMail(
  hookEventName: unknown,
  text: string,
): string | null {
  switch (hookEventName) {
    case "Stop":
      return JSON.stringify({
        should_block: true,
        block_reason: "a teammate wrote to you",
        continuation_fragments: [{ text }],
      });
    case "UserPromptSubmit":
      return JSON.stringify({ additional_context: text });
    default:
      // `PostToolUse` deliberately included: whether the retired schema
      // carried mail on it was never measured, and guessing a shape here is
      // the one failure mode this whole function exists to avoid — codex
      // refuses the entire answer and prints the refusal into the pane. An
      // install this old keeps its mail for a turn boundary, which is where
      // it went before any of this, and pays a round trip per tool call for
      // the refusal. That cost buys nothing, and it is the price of not
      // inventing a schema for a release nobody here can test against.
      return null;
  }
}

/**
 * Messages waiting for this pane, in the shape THIS install's codex accepts.
 *
 * The schema is a property of the release, not of the CLI, so the version
 * decides — see [`HOOK_SCHEMA_CHANGED_AT`]. Getting it wrong is not a soft
 * failure: codex refuses the whole answer, prints "hook returned invalid
 * user prompt submit JSON output" into the pane, and the teammate learns
 * nothing. That is exactly how the old shape was caught still shipping.
 *
 * `Stop` blocks and continues: the turn stays alive and `reason` is what the
 * model reads next, so a teammate's words arrive without anyone paying for a
 * fresh wake. codex refuses a block with an empty reason, which the text
 * below never is.
 *
 * `UserPromptSubmit` spills additional context into the session the user
 * just addressed, which is where mail that arrived while the pane sat idle
 * belongs.
 *
 * `PostToolUse` is the MID-TURN one, and the reason a person can correct a
 * working agent through mail instead of typing over their own half-written
 * message. It takes the same `additionalContext` envelope, under its own
 * event name — codex's generated schema
 * (`hooks/schema/generated/post-tool-use.command.output.schema.json`) allows
 * exactly `hookEventName` + `additionalContext`, and codex's own source
 * calls what comes back "model-facing hook feedback". This renderer used to
 * refuse the event on the belief that it read nothing back; that belief was
 * wrong, and it cost the mid-turn channel for as long as it stood.
 *
 * Its COST is real and worth stating: codex fires this once per TOOL CALL,
 * not once per model request the way claude's `PostToolBatch` does, so a
 * tool-heavy turn buys a round trip per call. The deck answers in
 * milliseconds when there is no mail, which is what makes that affordable.
 *
 * ⚠️ codex renders a history cell for a hook that PRINTS, so a delivery is
 * visible in the transcript. That is a cosmetic cost paid only when there
 * is actually mail — the reporter stays silent on every other turn — and it
 * is the honest trade for an envelope the model can tell apart from its
 * user's own words.
 */
/**
 * The events armed to ASK, declared beside the renderer that answers them.
 *
 * The two must agree and nothing else would notice them disagreeing: armed
 * but not rendered burns the hook's whole wait on every fire and takes
 * messages out of the queue to put them straight back; rendered but not
 * armed leaves that event's mail to a paid terminal nudge. Both silent.
 */
export const CODEX_MAIL_CHANNELS: readonly MailChannel[] = [
  { event: "SessionStart", atTurnEnd: false },
  { event: "UserPromptSubmit", atTurnEnd: false },
  { event: "PostToolUse", atTurnEnd: false },
  { event: "Stop", atTurnEnd: true },
];

/**
 * Whose report this is. A subagent's hook carries `agent_id` and
 * `agent_type`; the main agent's carries neither — and `session_id` is the
 * SHARED thread id, so it tells nothing apart (verified live on 0.163.0: a
 * child's UserPromptSubmit and PostToolUse reach this reporter with the
 * root's session id and process group).
 *
 * A subagent's report never moves the pane: its prompt is not the pane's
 * turn, its tool use resolves no wait of the pane's, and it ends with
 * `SubagentStop`, which is not armed. A report nobody can attribute — one the
 * reporter cut down to its name — keeps moving the pane as before: a
 * stranded Stop is the failure the reduction exists to prevent.
 */
export const attributeCodexEvent = (payload: unknown): EventAttribution | null => {
  const decoded = decodeStatusPayload(payload);
  if (!decoded) return null;
  if (decoded.source === "record") return { event: null, actor: "main", status: true };
  const event = asNonEmptyString(decoded.event.hook_event_name);
  if (!event) return null;
  const actor = actorFromFields(decoded.event, decoded.reduced, CODEX_HOOK_ACTOR_FIELDS);
  return { event, actor, status: actor !== "child" };
};

/** Where codex's hook payloads name who raised them — the fields its hooks
 * share with claude's: `agent_id` for a subagent, `session_id` for all. */
const CODEX_HOOK_ACTOR_FIELDS = { childId: "agent_id", sessionId: "session_id" } as const;

export const renderCodexMail: MailReplyRenderer = (input) => {
  const text = teammateText(input);
  const event = input.event.hook_event_name;
  if (wantsLegacySchema(input.cliVersion)) {
    return renderLegacyCodexMail(event, text);
  }
  switch (event) {
    case "Stop":
      return JSON.stringify({ decision: "block", reason: text });
    case "UserPromptSubmit":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: text,
        },
      });
    case "SessionStart":
    case "PostToolUse":
      // The same envelope under each event's own name, which is what
      // codex's schema for each allows. PostToolUse is the mid-turn door:
      // the turn keeps running and the words are context the model reads on
      // its next request. SessionStart is the one after a compaction: an
      // automatic one inside a turn drains it before the continuing request
      // (verified live on 0.163.0), so the briefing the compaction re-states
      // is in front of the model before it works on.
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: text,
        },
      });
    default:
      // PermissionRequest reports a fact and reads nothing back; printing
      // there would leave a history cell for no effect.
      return null;
  }
};

/**
 * codex's turn-lifecycle payloads → status edges. The reporter wraps each
 * hook payload verbatim under `event`; fields live-verified on 0.145/0.146.
 *
 * API-error turns have no terminal failure hook. The rollout's
 * task_complete.error supplies that ending (verified on 0.153.2). Native
 * Interrupt exists in that version too; this plugin keeps its cross-version
 * fallback, which arrives from the host's
 * rollout tailer as `kind: "store.record"` (marker = a record of TYPE
 * `turn_aborted`, so assistant text can't trip it), stamped with the
 * marker's own time. EVERY abort reason maps to `interrupted`, not just
 * the user's Esc: an aborted turn did not complete, and `turn-end` would
 * announce "finished" for a turn that was cut — the smaller lie is a
 * quiet "Interrupted" (whose announce is suppressed by design). In the
 * common non-Esc case ("replaced") a new turn's own edge follows at once
 * and settles the display anyway.
 *
 * UserPromptSubmit/Stop remain low-latency bookends. Blocking questions need
 * the rollout's mode plus correlated function_call/output, decoded separately
 * in questions.ts. The transient RequestUserInput event is not persisted.
 *
 * The real gap is that codex never reports an approval ANSWER. Measured
 * sequence for one escalated command:
 *
 *   UserPromptSubmit · PreToolUse · PostToolUse (the sandbox refused)
 *   PreToolUse · PermissionRequest        ← the ask
 *      [the user answers — nothing is emitted, and the rollout is silent too]
 *   PostToolUse                           ← the approved command FINISHED
 *   Stop
 *
 * `PreToolUse` fires BEFORE the ask, so arming it would buy no resolution.
 * The host closes this itself, from the user's own keystroke. The
 * `PostToolUse` case below therefore remains the backstop for an answer
 * given some other way, not the primary resolution.
 */
function continuesFromReply(reply?: string): boolean {
  if (!reply) return false;
  try {
    const output: unknown = JSON.parse(reply);
    if (!isJsonRecord(output) || output.continue === false) return false;
    return (output.decision === "block" && typeof output.reason === "string" && output.reason.trim() !== "") ||
      (output.should_block === true && typeof output.block_reason === "string" && output.block_reason.trim() !== "");
  } catch {
    return false;
  }
}

const readCodexStatus = (
  payload: unknown,
  at: number,
  context?: { readonly reply?: string },
): AgentStatusEvent | null => {
  const decoded = decodeStatusPayload(payload);
  if (!decoded) return null;
  if (decoded.source === "record") {
    // A rollout record the host carried because THIS plugin's watch named
    // it. The host did not read it: it compared two keys, one of them a
    // level down, and copied two fields. What it means is decided here.
    return codexRecords.read(decoded.record);
  }
  switch (decoded.event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      if (continuesFromReply(context?.reply)) return { kind: "turn-observed", at };
      return { kind: "turn-end", at };
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    case "PostCompact":
      // The context was rebuilt — what retires a recorded failure, as it
      // does for claude's compaction. A manual `/compact` reports it at once.
      return { kind: "context-compacted", at };
    case "SessionStart":
      // The same rebuild, from the hook that can carry its re-stated
      // briefing: announced by this report, the briefing is queued before
      // the report's own ask is answered. PostCompact has already said it
      // for an automatic compaction; a second announcement re-states the
      // same standing context, which supersedes itself in the queue. A
      // manual `/compact` defers this hook to the next turn, where the
      // announcement is no longer news but the delivery still is. The other
      // sources are a session at its prompt and mint nothing.
      return decoded.event.source === "compact" ? { kind: "context-compacted", at } : null;
    case "Interrupt":
      // The user's Esc on the main thread (codex runs it for no subagent),
      // the same edge the rollout's turn_aborted reports later.
      return { kind: "interrupted", at };
    case "PostToolUse":
      // The backstop, not the resolution: an approved tool's completion is
      // the first post-approval hook codex sends, which is as late as the
      // command is long. The host's own read of the user's answer clears
      // the wait when it is given; this still settles a pane whose answer
      // never came through us. Mid-turn repeats are absorbed by the reducer
      // without an emit.
      return { kind: "resumed", at, reason: "permission" };
    default:
      return null;
  }
};

export const normalizeCodexStatus: StatusNormalizer = (payload, at, context) => {
  const decoded = decodeStatusPayload(payload);
  const record = decoded?.source === "record" ? decoded.record : null;
  return codexQuestionStatus(context?.state, record, readCodexStatus(payload, at, context));
};
