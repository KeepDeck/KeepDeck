import {
  frameTeammateMail,
  isJsonRecord,
  reduceQuestionStatus,
  type AgentStatusEvent,
  type MailReplyRenderer,
  type StatusNormalizer,
  type QuestionState,
} from "@keepdeck/plugin-api";
import { kimiRecords } from "./tail";
import { kimiQuestionCall } from "./questions";

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
 * Terminal hooks have no agent identity in 0.40.1 and fire on child agents
 * too. They are mail boundaries, not pane endings. The main wire supplies
 * actual completion/failure/cancellation, including after Stop continuation.
 */
const readKimiStatus = (
  payload: unknown,
  at: number,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload)) return null;
  if (payload.kind === "store.record") {
    return isJsonRecord(payload.record) ? kimiRecords.read(payload.record) : null;
  }
  if (!isJsonRecord(payload.event)) return null;
  const event = payload.event;
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
    case "Interrupt":
    case "StopFailure":
      return null;
    case "PermissionRequest":
      if (event.agent_id !== "main") return null;
      return { kind: "waiting", at, reason: "permission" };
    case "PermissionResult":
      if (event.agent_id !== "main") return null;
      return { kind: "resumed", at, reason: "permission" };
    default:
      return null;
  }
};

export const normalizeKimiStatus: StatusNormalizer = (payload, at, context) => {
  const record = isJsonRecord(payload) && payload.kind === "store.record" && isJsonRecord(payload.record)
    ? payload.record : null;
  const result = reduceQuestionStatus(context?.state as QuestionState | undefined,
    readKimiStatus(payload, at), record ? kimiQuestionCall(record) : undefined);
  return { kind: "status-reduction", ...result };
};
