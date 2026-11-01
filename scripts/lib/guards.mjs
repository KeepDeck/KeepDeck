/**
 * The narrowing the repo's scripts share: untyped data (JSON, YAML, a
 * module namespace) becomes a typed shape only through a check, never a
 * cast (task-585). One copy, because three had already drifted apart.
 */

/**
 * A plain keyed object: not null, and not an array — whose indexes would
 * otherwise pass for keys.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
