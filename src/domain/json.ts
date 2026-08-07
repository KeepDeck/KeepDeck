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
 * untouched (the forward-compat guarantee the migration ladder relies on).
 *
 * The bag has a NULL prototype, so a stored `"__proto__"` key becomes an
 * ordinary own property instead of hitting `Object.prototype`'s setter — on a
 * normal object that assignment silently re-points the bag's prototype, creates
 * no own property, and the key then vanishes from the next save. Every codec
 * here reads a hand-editable file, so that key is reachable, and the promise
 * being kept is "unknown keys survive". */
export function collectExtras(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const extras = Object.create(null) as Record<string, unknown>;
  for (const [key, v] of Object.entries(value)) {
    if (!known.has(key)) extras[key] = v;
  }
  return extras;
}
