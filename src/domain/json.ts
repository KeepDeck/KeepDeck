/**
 * Shared guards for reading untrusted JSON — the primitives every persistence
 * codec (deck, settings, plugin storage) and the migration ladder build their
 * field-by-field reads on.
 */

/** Whether `value` is a plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every entry of `value` whose key is NOT in `known` — the "extras" bag a codec
 * carries so a newer revision's unknown fields survive a load→save round-trip
 * untouched (the forward-compat guarantee the migration ladder relies on). */
export function collectExtras(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!known.has(key)) extras[key] = v;
  }
  return extras;
}
