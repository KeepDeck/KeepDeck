// @ts-check
/**
 * The one record guard the plugin's two halves share. A value from a host
 * boundary is `unknown` until this proves it is an object; a second copy of
 * the test would be a second answer to what "record" means.
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null;
}
