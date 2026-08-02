import {
  asNonEmptyString,
  isJsonRecord,
  statusSourceInstant,
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
 *   the user": `permission_prompt` and `agent_needs_input`. Binary-verified
 *   caveat (2.1.220): these are 6-second IDLE NUDGES, not dialog-open
 *   events — while the user keeps typing they may never fire, and even
 *   idle they run ≥6s late. The waiting edge is therefore best-effort for
 *   claude; `Stop` still settles the turn either way. `idle_prompt` and
 *   the rest are not turn states — dropped.
 * - `PostToolUse` → resumed. claude has no approval-REPLY hook, but an
 *   approved tool RUNS — its completion is the first post-approval hook
 *   and proves the wait resolved. For a long-running tool the amber
 *   clears only when the tool finishes (late, but bounded by the tool,
 *   not the turn); mid-turn repeats are absorbed by the reducer without
 *   an emit, so per-tool volume costs nothing downstream.
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
  if (payload.kind === "session.interrupt") {
    // The marker's OWN time, not receipt: the tail polls, so receipt runs
    // up to an interval late — stamped honestly, a marker that predates the
    // next turn's start is droppable as stale.
    return { kind: "interrupted", at: statusSourceInstant(payload, at) };
  }
  if (!isJsonRecord(payload.event)) return null;
  const event = payload.event;
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      return { kind: "turn-end", at };
    case "PostToolUse":
      return { kind: "resumed", at };
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
