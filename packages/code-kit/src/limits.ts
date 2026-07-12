/**
 * When highlighting is worth it. Tokenizing is O(text) with a real constant
 * factor (TextMate grammars over a JS regex engine), and the result multiplies
 * the DOM (one span per colored run instead of one text node per line) — past
 * a point the color isn't worth the stall. Over-limit files render plain,
 * which is exactly what the viewer showed before the kit existed.
 *
 * Context for the byte cap: the host's fs read cap is 1 MB by default
 * (src-tauri project_fs.rs), so the viewer never sees more than that anyway;
 * highlighting bows out at half of it.
 */

/** Don't highlight past this many UTF-16 units (~bytes for ASCII source). */
export const MAX_HIGHLIGHT_CHARS = 512 * 1024;

/** One line this long means generated/minified content — grammar state on such
 * a line costs seconds, and nobody reads minified code by color. */
export const MAX_HIGHLIGHT_LINE_CHARS = 4000;

/** Whether `text` is sane to tokenize. All-or-nothing on purpose: a partial
 * highlight (some lines colored, some not) reads as a rendering bug. */
export function canHighlight(text: string): boolean {
  if (text.length > MAX_HIGHLIGHT_CHARS) return false;
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const lineEnd = end === -1 ? text.length : end;
    if (lineEnd - start > MAX_HIGHLIGHT_LINE_CHARS) return false;
    if (end === -1) break;
    start = end + 1;
  }
  return true;
}
