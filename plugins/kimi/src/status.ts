import {
  asNonEmptyString,
  isJsonRecord,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

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
 * - `StopFailure` with the error class IN the payload (`error_type` in
 *   agent-core v1, `errorType` in v2 — both read here).
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
    case "StopFailure": {
      const detail =
        asNonEmptyString(event.error_message) ??
        asNonEmptyString(event.errorMessage);
      return {
        kind: "turn-failed",
        at,
        error:
          asNonEmptyString(event.error_type) ??
          asNonEmptyString(event.errorType) ??
          "unknown",
        ...(detail !== undefined ? { detail } : {}),
      };
    }
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    case "PermissionResult":
      return { kind: "resumed", at };
    default:
      return null;
  }
};
