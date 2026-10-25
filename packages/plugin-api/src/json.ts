/** Whether `value` is a plain JSON object: not null, not an array. The one
 * guard every reader of untrusted JSON starts from — the manifest validator,
 * the authoring helpers, the host's codecs. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The keys of a table written as a literal — a `satisfies Record<K, …>`
 * constant, say — typed as its keys. `Object.keys` answers `string[]`
 * because an object in general may carry more than its type names; a table
 * literal carries exactly what it declares, so its own keys are its
 * `keyof`. Not for anything read from outside.
 */
export function keysOf<T extends object>(table: T): Extract<keyof T, string>[] {
  return Object.keys(table).filter((key): key is Extract<keyof T, string> =>
    Object.prototype.hasOwnProperty.call(table, key),
  );
}
