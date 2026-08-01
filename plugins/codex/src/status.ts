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
 * marker's own time and carrying codex's abort reason: only "interrupted"
 * is the user's hand, every other abort still ENDS the turn but labelling
 * it "Interrupted" would claim an Esc nobody pressed.
 */
export const normalizeCodexStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload)) return null;
  if (payload.kind === "session.interrupt") {
    const instant = statusSourceInstant(payload, at);
    return payload.reason === "interrupted"
      ? { kind: "interrupted", at: instant }
      : { kind: "turn-end", at: instant };
  }
  if (!isJsonRecord(payload.event)) return null;
  switch (payload.event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      return { kind: "turn-end", at };
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    default:
      return null;
  }
};
