import {
  frameTeammateMail,
  isJsonRecord,
  turnFailedEvent,
  type AgentStatusEvent,
  type MailReplyRenderer,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * Messages waiting for this pane, in the shape kimi's hooks accept.
 *
 * kimi does NOT speak claude's hook-output schema, and this file used to
 * assume it did — `decision`/`reason` on `Stop`, a root `additionalContext`
 * on `UserPromptSubmit`. Both were dropped in silence, so kimi never
 * received a single message through this channel; the only ones that landed
 * came through the terminal. Its parser (`HookJsonOutputSchema`, read out of
 * the shipped 0.34.0 binary) accepts exactly two keys — `message` and
 * `hookSpecificOutput` — and is a LOOSE object, so anything else validates
 * fine and means nothing.
 *
 * `UserPromptSubmit` takes a plain `message`: kimi appends every non-blocking
 * hook message to the turn the person just opened, wrapped in its own
 * `<hook_result>` element.
 *
 * `Stop` takes only a BLOCK, and kimi has one way to express one in stdout:
 * `permissionDecision: "deny"` with the text in `permissionDecisionReason`.
 * The wording is the permission vocabulary reused — for `Stop` it means "do
 * not stop", and kimi appends the reason and keeps the turn running, which
 * is the same trade the other two CLIs make. The alternative is exit 2 with
 * the text on stderr, rejected because the reporter is one script shared by
 * three CLIs and its exit code is not the deck's to vary.
 *
 * The framing is the point. `<teammate-message>` names whose words these
 * are and the sentence after it says how much authority they carry: another
 * agent's output, not the human's instruction. A terminal paste can say
 * neither, because it arrives as keystrokes indistinguishable from typing.
 */
export const renderKimiMail: MailReplyRenderer = ({ event, messages, waiting }) => {
  const text = frameTeammateMail(messages, waiting);
  switch (event.hook_event_name) {
    case "Stop":
      return JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: text,
        },
      });
    case "UserPromptSubmit":
      return JSON.stringify({ message: text });
    default:
      // StopFailure, Interrupt and the permission pair report a fact and
      // read nothing back.
      return null;
  }
};

/**
 * kimi's turn-lifecycle payloads → status edges. The reporter (a hook in
 * the user-installed companion plugin) wraps each payload verbatim under
 * `event`; base fields per kimi's hooks doc: `{hook_event_name, session_id,
 * cwd}`, snake_case.
 *
 * kimi's surface is the most complete of the four:
 * - a DEDICATED `Interrupt` event ("Stop does not fire on interrupts, so
 *   this event fires instead") — no transcript recovery needed;
 * - `PermissionResult` — the approval-resolution edge claude/codex lack;
 * - `StopFailure` with the error class IN the payload. Binary-verified:
 *   kimi's `toHookInputData` snake-cases EVERY key in both engine
 *   generations, so `error_type`/`error_message` are the only spellings
 *   that reach a hook.
 */
export const normalizeKimiStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload) || !isJsonRecord(payload.event)) return null;
  const event = payload.event;
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      return { kind: "turn-end", at };
    case "Interrupt":
      return { kind: "interrupted", at };
    case "StopFailure":
      return turnFailedEvent(at, event.error_type, event.error_message);
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    case "PermissionResult":
      return { kind: "resumed", at };
    default:
      return null;
  }
};
