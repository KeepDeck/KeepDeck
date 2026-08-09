import {
  frameTeammateMail,
  isJsonRecord,
  statusSourceInstant,
  type AgentStatusEvent,
  type MailReplyInput,
  type MailReplyRenderer,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/** The teammate framing both events below carry, worded once for every CLI
 * in [`frameTeammateMail`]. */
const teammateText = ({ messages }: MailReplyInput): string =>
  frameTeammateMail(messages);

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

/** `0.147.0` → `[0, 147, 0]`; anything unparseable → null. Padded to three,
 * so `0.147` and `0.147.0` compare equal rather than one ranking below the
 * other on a missing component. */
function versionParts(version: string | null): number[] | null {
  if (!version) return null;
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Whether this install wants the pre-0.147 schema.
 *
 * An unknown version answers FALSE — the current schema is the one that
 * works on every install anyone is running today, and a probe can come back
 * empty for reasons that have nothing to do with the release. Guessing "old"
 * on no evidence would break the working case to serve a retired one.
 */
function wantsLegacySchema(cliVersion: string | null): boolean {
  const parts = versionParts(cliVersion);
  if (!parts) return false;
  // Lexicographic, and it has to short-circuit on the FIRST component that
  // differs: 1.0.0 is newer than 0.147.0 even though its second component is
  // smaller, and a comparison that kept looking would call it older.
  for (let i = 0; i < HOOK_SCHEMA_CHANGED_AT.length; i += 1) {
    if (parts[i] !== HOOK_SCHEMA_CHANGED_AT[i]) {
      return parts[i] < HOOK_SCHEMA_CHANGED_AT[i];
    }
  }
  return false;
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
 * ⚠️ codex renders a history cell for a hook that PRINTS, so a delivery is
 * visible in the transcript. That is a cosmetic cost paid only when there
 * is actually mail — the reporter stays silent on every other turn — and it
 * is the honest trade for an envelope the model can tell apart from its
 * user's own words.
 */
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
    default:
      // PermissionRequest and PostToolUse report a fact and read nothing
      // back; printing there would leave a history cell for no effect.
      return null;
  }
};

/**
 * codex's turn-lifecycle payloads → status edges. The reporter wraps each
 * hook payload verbatim under `event`; fields live-verified on 0.145/0.146.
 *
 * codex's surface is the narrowest of the four: `PermissionRequest` is its
 * only waiting edge, and it has NO failure event — an API-error turn is
 * invisible to hooks (a known gap; only the rollout could tell). A user
 * interrupt pushes no hook either — that edge arrives from the host's
 * rollout tailer as `kind: "session.interrupt"` (marker = a record of TYPE
 * `turn_aborted`, so assistant text can't trip it), stamped with the
 * marker's own time. EVERY abort reason maps to `interrupted`, not just
 * the user's Esc: an aborted turn did not complete, and `turn-end` would
 * announce "finished" for a turn that was cut — the smaller lie is a
 * quiet "Interrupted" (whose announce is suppressed by design). In the
 * common non-Esc case ("replaced") a new turn's own edge follows at once
 * and settles the display anyway.
 *
 * ALL FOUR armed events exist and fire — measured on 0.146, and stated by
 * codex's own `HookEventsToml`, which carries eleven names including the two
 * an audit once reported missing. Do not "fix" a stuck badge by dropping
 * `UserPromptSubmit`/`Stop` for rollout-sourced bookends: they are the only
 * bookends codex has, and the tailer would replace working edges with
 * polled ones.
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
export const normalizeCodexStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload)) return null;
  if (payload.kind === "session.interrupt") {
    return { kind: "interrupted", at: statusSourceInstant(payload, at) };
  }
  if (!isJsonRecord(payload.event)) return null;
  switch (payload.event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      return { kind: "turn-end", at };
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    case "PostToolUse":
      // The backstop, not the resolution: an approved tool's completion is
      // the first post-approval hook codex sends, which is as late as the
      // command is long. The host's own read of the user's answer clears
      // the wait when it is given; this still settles a pane whose answer
      // never came through us. Mid-turn repeats are absorbed by the reducer
      // without an emit.
      return { kind: "resumed", at };
    default:
      return null;
  }
};
