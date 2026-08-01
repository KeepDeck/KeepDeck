import {
  asNonEmptyString,
  isJsonRecord,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * opencode's turn-lifecycle payloads → status edges. The session reporter
 * (this plugin's own code inside the opencode process) pre-filters the bus:
 * root-session events only, `session.status` forwarded only when busy —
 * so the mapping here is one-to-one.
 *
 * opencode is the one CLI needing no out-of-band recovery: `session.idle`
 * fires on interrupt too, and `permission.replied` supplies the
 * approval-resolution edge claude and codex lack.
 */
export const normalizeOpencodeStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload) || !isJsonRecord(payload.event)) return null;
  const event = payload.event;
  switch (event.type) {
    case "session.status":
      return { kind: "turn-start", at };
    case "session.idle":
      return { kind: "turn-end", at };
    case "session.error": {
      return {
        kind: "turn-failed",
        at,
        error: asNonEmptyString(event.error) ?? "session.error",
      };
    }
    case "permission.asked":
      return { kind: "waiting", at, reason: "permission" };
    case "permission.replied":
      return { kind: "resumed", at };
    default:
      return null;
  }
};
