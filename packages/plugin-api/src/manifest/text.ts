/**
 * Guards for text that untrusted plugins put in front of the user (manifest
 * names, notification titles/bodies). The threat is not markup — React and
 * the OS escape that — but INVISIBLE restructuring: control characters, line
 * and paragraph separators that push a host-added attribution prefix out of
 * view, and bidi controls that visually reorder it away. One codepoint class,
 * shared by the manifest validator (reject) and the host's notification port
 * (strip), so the two can never disagree about what "clean" means.
 */

/** C0/C1 controls (incl. tab/newline), the Unicode line/paragraph separators,
 * and every bidi control (ALM, LRM/RLM, embeddings/overrides, isolates). */
const UNSAFE_TEXT_CLASS =
  "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";

/** Whether `value` contains any unsafe codepoint. Stateless (no `g` flag). */
export function hasUnsafeText(value: string): boolean {
  return new RegExp(`[${UNSAFE_TEXT_CLASS}]`).test(value);
}

/** `value` with unsafe codepoints replaced by spaces, whitespace runs
 * collapsed, and the ends trimmed — a single visual line, safe to prefix. */
export function stripUnsafeText(value: string): string {
  return value
    .replace(new RegExp(`[${UNSAFE_TEXT_CLASS}]`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}
