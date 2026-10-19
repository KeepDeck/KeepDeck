/** Whether `value` is a plain JSON object: not null, not an array. The one
 * guard every reader of untrusted JSON starts from — the manifest validator,
 * the authoring helpers, the host's codecs. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
