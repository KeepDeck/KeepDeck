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
 *
 * KNOWN LIMIT: the bus carries no abort event, so an Esc'd turn is
 * indistinguishable from a completed one — both arrive as `session.idle`
 * and read "Done", and the finish may announce for a turn the user cut.
 * Bounded in practice: idle lands ~45ms after the Esc, so the user is
 * still looking at the pane and the visibility rule downgrades the OS
 * banner to seen-in-place; only the bell entry says "finished" where
 * "interrupted" would be truer.
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
