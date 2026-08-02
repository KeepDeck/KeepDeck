import {
  isJsonRecord,
  statusSourceInstant,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

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
      // The approval-resolution stand-in: an approved tool's completion is
      // the first post-approval hook. Mid-turn repeats are absorbed by the
      // reducer without an emit.
      return { kind: "resumed", at };
    default:
      return null;
  }
};
