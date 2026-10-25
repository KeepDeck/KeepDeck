/**
 * Shared guards for reading untrusted JSON — the primitives every persistence
 * codec (deck, settings, plugin storage) and the migration ladder build their
 * field-by-field reads on.
 */

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
  const extras = nullPrototypeRecord<unknown>();
  for (const [key, v] of Object.entries(value)) {
    if (!known.has(key)) extras[key] = v;
  }
  return extras;
}

/**
 * The keys of a table this codebase writes as a literal — a `satisfies
 * Record<K, …>` constant, say — typed as its keys. `Object.keys` answers
 * `string[]` because an object in general may carry more than its type
 * names; a table literal carries exactly what it declares, so its own keys
 * are its `keyof`. Not for anything read from outside.
 */
export function keysOf<T extends object>(table: T): Extract<keyof T, string>[] {
  return Object.keys(table).filter((key): key is Extract<keyof T, string> => Object.prototype.hasOwnProperty.call(table, key));
}

/** Whether `value` is a JSON object whose every value is a string. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** Whether `value` is one of `allowed` — a closed set of literals read off
 * untrusted input. */
export function isOneOf<T extends string | number | boolean>(allowed: readonly T[], value: unknown): value is T {
  return allowed.some((candidate) => candidate === value);
}

/** Whether `value` is any object at all — an array included — to be read
 * key by key. For the tolerant readers that have only ever asked
 * `typeof value === "object"`: every key they read off an array is simply
 * absent. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An empty record with no prototype: a key read from outside ("__proto__"
 * included) lands as an own property instead of reaching `Object.prototype`. */
export function nullPrototypeRecord<V>(): Record<string, V> {
  return Object.create(null);
}
