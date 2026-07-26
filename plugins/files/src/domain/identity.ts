/**
 * What the preview is showing, as a comparable value — the answer to "is this
 * still the same thing the reader was looking at?". No React, no services.
 */

/**
 * A file plus the rendering of it. A Markdown document and its source share a
 * path but not a single line, so carrying a position between them lands
 * nowhere in particular — and since the rendered view is the shorter of the
 * two, that position would be clamped away and lost in BOTH.
 *
 * Wrapping is deliberately not here. It is the same document with the same
 * lines, only laid out differently, so it is not a different thing to read;
 * the reader's place across a wrap toggle is a LINE, held by the viewer.
 *
 * NUL-joined so a path can never spell out the suffix.
 */
export function previewKey(path: string, rendered: boolean): string {
  return [path, rendered ? "document" : "source"].join("\0");
}
