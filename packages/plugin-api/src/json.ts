/** A value JSON can carry as it is. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Whether `value` is made of JSON values only, all the way down — what a
 * value from a manifest or the plugin wire must be before it is sent on as
 * JSON (a structured clone can carry a Date, a Map, a NaN). */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isJsonRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJsonValue)
  );
}

/** Whether `value` is a plain JSON object: not null, not an array. The one
 * guard every reader of untrusted JSON starts from — the manifest validator,
 * the authoring helpers, the host's codecs. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every key of `T`, listed once by hand and proven complete by the compiler:
 * `keyList<typeof TABLE>()(["a", "b"])` compiles only when the list names
 * each key of the table and nothing else. `Object.keys` answers `string[]`,
 * and a function that narrowed it would be trusting the table, not checking
 * it; here nothing is trusted — a key added to the table and not to the list
 * is a compile error.
 */
export function keyList<T>() {
  return <const K extends readonly Extract<keyof T, string>[]>(
    keys: K & (Exclude<Extract<keyof T, string>, K[number]> extends never ? unknown : never),
  ): readonly K[number][] => keys;
}
