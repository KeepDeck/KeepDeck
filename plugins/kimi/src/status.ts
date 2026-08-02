import {
  isJsonRecord,
  turnFailedEvent,
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
