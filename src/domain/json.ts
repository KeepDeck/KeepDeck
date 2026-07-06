/**
 * Shared guards for reading untrusted JSON — the primitives every persistence
 * codec (deck, settings, plugin storage) and the migration ladder build their
 * field-by-field reads on.
 */

/** Whether `value` is a plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
