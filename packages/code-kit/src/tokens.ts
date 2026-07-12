/**
 * The kit's token model — deliberately tiny and engine-free. Consumers render
 * `LineTokens[]` (one entry per source line); only `alignTokens` knows it came
 * from Shiki. Keeping the model structural (no Shiki type imports at runtime)
 * lets the pure alignment logic be tested without booting a grammar engine.
 */

/** One colored run of text within a line. `color` is a hex from the theme;
 * absent means the consumer's default text color applies. */
export interface Token {
  text: string;
  color?: string;
  italic?: boolean;
}

/** One source line as its colored runs. Empty array = an empty line (the
 * renderer substitutes the height-preserving space, same as the plain path). */
export type LineTokens = Token[];

/** The slice of Shiki's `ThemedToken` the alignment reads — structural, so
 * tests can hand in plain objects. `fontStyle` is Shiki's bitmask (1=italic). */
export interface ThemedTokenLike {
  content: string;
  color?: string;
  fontStyle?: number;
}

const FONT_STYLE_ITALIC = 1;

/**
 * Marry the engine's per-line tokens to the EXACT lines the viewer renders
 * (`text.split("\n")`), defensively: highlighting must never change what text
 * is on screen, so any line whose tokens don't reconstruct it verbatim falls
 * back to one plain run of the original line — misalignment costs color, never
 * content.
 *
 * Two engine quirks are absorbed here rather than trusted not to happen:
 * - CRLF: Shiki splits on `\r?\n` and drops the `\r`; the viewer's naive
 *   `split("\n")` keeps it. When tokens reconstruct everything but a trailing
 *   `\r`, the `\r` is re-attached as a colorless run (invisible under
 *   `white-space: pre`, but the on-screen text stays byte-identical).
 * - Line-count drift (e.g. a trailing newline tokenized as no extra line):
 *   missing lines fall back to plain; surplus engine lines are ignored.
 */
export function alignTokens(
  lines: readonly string[],
  themed: readonly (readonly ThemedTokenLike[])[],
): LineTokens[] {
  return lines.map((line, index) => {
    if (line === "") return [];
    const source = themed[index];
    if (!source) return [{ text: line }];
    const tokens: Token[] = [];
    for (const token of source) {
      if (token.content === "") continue;
      tokens.push({
        text: token.content,
        ...(token.color ? { color: token.color } : {}),
        ...(((token.fontStyle ?? 0) & FONT_STYLE_ITALIC) !== 0
          ? { italic: true }
          : {}),
      });
    }
    const joined = tokens.map((token) => token.text).join("");
    if (joined === line) return tokens;
    if (line.endsWith("\r") && joined === line.slice(0, -1)) {
      return [...tokens, { text: "\r" }];
    }
    return [{ text: line }];
  });
}
