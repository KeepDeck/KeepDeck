import {
  asNonEmptyString,
  isJsonRecord,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * claude's turn-lifecycle payloads → status edges. The reporter wraps each
 * hook payload verbatim under `event`; the fields here are pinned by the
 * shipped binary's own hook schemas (2.1.220):
 *
 * - `UserPromptSubmit` → the turn is running.
 * - `Stop` → the turn completed. Fires INSTEAD of `StopFailure`, never both.
 * - `StopFailure` → the turn died on an API error; `error` is claude's
 *   typed reason (`rate_limit`, `authentication_failed`, …), verified to
 *   ride in the payload — no per-matcher fan-out needed.
 * - `Notification` → waiting, but only the two types that mean "parked on
 *   the user": `permission_prompt` (approval dialog) and
 *   `agent_needs_input` (the agent asked). `idle_prompt` and the rest are
 *   not turn states — dropped.
 *
 * A user interrupt (Esc) pushes NO hook — that edge arrives from the
 * host's transcript tailer as a `kind: "session.interrupt"` payload
 * (marker = the structured `interruptedMessageId` field on the transcript
 * record, so an assistant merely quoting the phrase can't trip it).
 */
export const normalizeClaudeStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload)) return null;
  if (payload.kind === "session.interrupt") return { kind: "interrupted", at };
  if (!isJsonRecord(payload.event)) return null;
  const event = payload.event;
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      return { kind: "turn-end", at };
    case "StopFailure": {
      const detail = asNonEmptyString(event.error_details);
      return {
        kind: "turn-failed",
        at,
        error: asNonEmptyString(event.error) ?? "unknown",
        ...(detail !== undefined ? { detail } : {}),
      };
    }
    case "Notification":
      switch (event.notification_type) {
        case "permission_prompt":
          return { kind: "waiting", at, reason: "permission" };
        case "agent_needs_input":
          return { kind: "waiting", at, reason: "question" };
        default:
          return null;
      }
    default:
      return null;
  }
};
