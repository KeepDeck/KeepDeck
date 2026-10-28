import { CARRIED_RECORD, isJsonRecord, type AgentStatus } from "@keepdeck/plugin-api";

/**
 * A status envelope named for a log line — what kind of report it was,
 * never what it said.
 *
 * A hook envelope is named by its event as the agent's plugin reads it
 * (`attributedEvent`: `UserPromptSubmit`, `Stop`, `session.idle`); a record
 * the native tail carried by its transport (`store.record`, or
 * `store.batch(3)` for three records in one drain), marked when the tail
 * read it from the file as it was when it armed: `reconcile` for a turn
 * boundary, `context` for decoder metadata, `catch-up` for usage. Nothing
 * from a payload's body is read here: the label must be safe to log for any
 * agent, and the core knows no agent's fields.
 *
 * The name comes out of an envelope, so it is whatever the pane's process
 * wrote: anything but a short plain token is not used — a newline in it
 * would forge a second log entry, a long one would bury the real lines.
 */
export function statusPayloadLabel(payload: unknown, eventName: string | null): string {
  if (!isJsonRecord(payload)) return "an unreadable event";
  if (isJsonRecord(payload.event)) {
    return eventName !== null && /^[\w.-]{1,64}$/.test(eventName) ? eventName : "an unreadable event";
  }
  // A usage replay carries `catchUp`; a status replay rides as a
  // `reconcile` (it may only end a turn) or as context only.
  const mark = payload.reconcile === true ? "reconcile"
    : payload.contextOnly === true ? "context"
    : payload.catchUp === true ? "catch-up"
    : null;
  if (payload.kind === CARRIED_RECORD) return mark ? `${CARRIED_RECORD}(${mark})` : CARRIED_RECORD;
  if (payload.kind === "store.batch") {
    const count = Array.isArray(payload.records) ? payload.records.length : 0;
    return `store.batch(${count}${mark ? `, ${mark}` : ""})`;
  }
  return "an unreadable event";
}

/** The event's own name as the agent's plugin reads it — the same reading
 * that admits the report — or null. Its plugin's code: a throw is no name. */
export function attributedEvent(
  status: Pick<AgentStatus, "attribute"> | undefined,
  payload: unknown,
): string | null {
  try {
    return status?.attribute(payload)?.event ?? null;
  } catch {
    return null;
  }
}
