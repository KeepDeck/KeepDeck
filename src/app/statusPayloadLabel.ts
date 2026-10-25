import { CARRIED_RECORD, isJsonRecord } from "@keepdeck/plugin-api";

/**
 * A status envelope named for a log line — what kind of report it was,
 * never what it said.
 *
 * A hook envelope is named by its event (`UserPromptSubmit`, `Stop`); a
 * record the native tail carried by its transport (`store.record`, or
 * `store.batch(3)` for three records in one drain), marked `catch-up` when
 * the tail read it from the file as it was when it armed. Nothing from a
 * record's body is read: the label must be safe to log for any agent, and
 * the core knows no agent's fields.
 *
 * The name comes out of an envelope, so it is whatever the pane's process
 * wrote: anything but a short plain token is not used — a newline in it
 * would forge a second log entry, a long one would bury the real lines.
 */
export function statusPayloadLabel(payload: unknown): string {
  if (!isJsonRecord(payload)) return "an unreadable event";
  const named = (value: unknown) =>
    typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : null;
  if (isJsonRecord(payload.event)) {
    return named(payload.event.hook_event_name) ?? named(payload.event.type) ?? "an unreadable event";
  }
  const catchUp = payload.catchUp === true;
  if (payload.kind === CARRIED_RECORD) return catchUp ? `${CARRIED_RECORD}(catch-up)` : CARRIED_RECORD;
  if (payload.kind === "store.batch") {
    const count = Array.isArray(payload.records) ? payload.records.length : 0;
    return `store.batch(${count}${catchUp ? ", catch-up" : ""})`;
  }
  return "an unreadable event";
}
