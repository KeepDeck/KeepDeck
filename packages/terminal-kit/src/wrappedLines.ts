/**
 * Reassemble xterm's wrapped buffer rows into logical lines, so link detection
 * ([F10]/[F14]) sees a whole URL/path even when the terminal wrapped it. Two
 * kinds of wrap are stitched:
 *
 *  1. SOFT wrap — xterm itself broke one long output line at the terminal width
 *     and flags every continuation row `isWrapped`. Scanning rows one by one
 *     matches only fragments (a wrapped link's tail looks like a relative path).
 *
 *  2. Application HARD wrap — the child program (e.g. an agent TUI) wrapped a
 *     path to the pane width ITSELF, emitting real newlines with a hanging
 *     indent on the continuation rows. Those rows are NOT `isWrapped` (genuine
 *     `\n`s) and carry a leading indent, so the soft-wrap walk never joins them.
 *     We stitch a seam only when it is width-forced and mid-token (see
 *     `hardSeam`), and strip the continuation's hanging indent before joining —
 *     the indent's width is tracked per row so `mapRange` still lands on the
 *     right cells. Requires the terminal `cols`; without it only soft wrap is
 *     joined (unchanged legacy behaviour).
 *
 * Pure against structural slices of xterm's buffer API (the `KeyEventLike`
 * pattern) so the walk and the offset math are unit-testable without xterm.
 */

/** The slice of xterm's IBufferLine the reassembly needs. */
export interface WrappedLineLike {
  /** True when this row continues the previous one (no hard newline before). */
  isWrapped: boolean;
  translateToString(trimRight: boolean): string;
}

/** The slice of xterm's IBuffer the reassembly needs. */
export interface WrappedBufferLike {
  getLine(y: number): WrappedLineLike | undefined;
}

/** A logical line: the 0-based buffer row it starts on plus one string per row. */
export interface LogicalLine {
  startRow: number;
  rows: string[];
  /**
   * Chars stripped from the LEFT of `rows[i]` — a hard-wrap continuation's
   * hanging indent. 0 for the head row and for soft-wrap continuations. Same
   * length as `rows`; `mapRange` adds it back to recover buffer columns.
   */
  indents: number[];
}

/**
 * Rows a logical line may span before the walk gives up extending. A cap keeps
 * a pathological line (minified JS dumped to the terminal) from turning every
 * hover into a giant regex scan; links crossing the cut stay fragments, like
 * xterm's own web-links addon under its scan cap.
 */
export const MAX_LOGICAL_ROWS = 64;

/**
 * A character legal inside a URL or file path — the alphabet a wrapped link
 * resumes with. Excludes whitespace and box-drawing/tree glyphs (`└├│─`, …),
 * so a new tree item on the next row is NOT mistaken for a continuation.
 */
const LINK_CHAR = /[A-Za-z0-9._@%+:~/#?&=\-]/;

/** Count of leading space characters in `s`. */
function leadingSpaces(s: string): number {
  let n = 0;
  while (s[n] === " ") n++;
  return n;
}

/**
 * Is buffer row `upperY + 1` an application-hard-wrap continuation of `upperY`?
 * Returns the continuation's hanging-indent width when so, else null.
 *
 * Conservative on purpose — three signals must all hold, mirroring how a TUI
 * wraps an over-long token:
 *  - the lower row is a REAL newline (`!isWrapped`) — a soft wrap is the other
 *    walk's job;
 *  - the upper row is WIDTH-FORCED: its trimmed content fills to `cols`, and its
 *    last cell is a link char, i.e. the break fell mid-token (a word wrap ends
 *    short of `cols` or on a space and is left alone);
 *  - the lower row, past its indent, RESUMES a token (first char is a link char,
 *    not a space and not a tree glyph).
 * Even if this occasionally joins unrelated rows, `detectLinks` only yields a
 * link when the joined text is a valid URL/path, so a bad join is inert.
 */
function hardSeam(
  buffer: WrappedBufferLike,
  upperY: number,
  cols: number | undefined,
): { indent: number } | null {
  if (cols === undefined) return null;
  const upper = buffer.getLine(upperY);
  const lower = buffer.getLine(upperY + 1);
  if (!upper || !lower || lower.isWrapped) return null;

  const upperTrim = upper.translateToString(true);
  if (upperTrim.length < cols) return null;
  if (!LINK_CHAR.test(upperTrim[upperTrim.length - 1] ?? "")) return null;

  const lowerFull = lower.translateToString(false);
  const indent = leadingSpaces(lowerFull);
  if (!LINK_CHAR.test(lowerFull[indent] ?? "")) return null;
  return { indent };
}

/** Does the logical line continue onto row `y + 1`? Soft wrap, else hard seam. */
function continuation(
  buffer: WrappedBufferLike,
  y: number,
  cols: number | undefined,
): { indent: number } | null {
  if (buffer.getLine(y + 1)?.isWrapped === true) return { indent: 0 };
  return hardSeam(buffer, y, cols);
}

/**
 * Collect the logical line containing buffer row `row` (0-based): walk up to the
 * head, then down while continuations (soft wrap or hard seam) follow. `cols`
 * enables hard-seam stitching; omit it for soft-wrap-only behaviour.
 *
 * Non-final rows keep their trailing whitespace (`translateToString(false)`) — a
 * genuine space at a soft-wrap column separates tokens, and trimming it would
 * glue `error in ` + `/path` into `in/path`; only the final row is right-trimmed.
 * A hard-wrap continuation's hanging indent is stripped from the left and
 * recorded in `indents`. Null when `row` isn't in the buffer.
 */
export function logicalLineAt(
  buffer: WrappedBufferLike,
  row: number,
  cols?: number,
): LogicalLine | null {
  if (!buffer.getLine(row)) return null;

  // Walk up to the head: soft-wrapped rows chain via `isWrapped`, hard-wrapped
  // rows via a seam with the row above. Bounded so the requested row is always
  // reachable in the downward pass, even against the cap.
  let startRow = row;
  while (row - startRow < MAX_LOGICAL_ROWS - 1 && buffer.getLine(startRow - 1)) {
    const soft = buffer.getLine(startRow)?.isWrapped === true;
    if (!soft && !hardSeam(buffer, startRow - 1, cols)) break;
    startRow--;
  }

  const rows: string[] = [];
  const indents: number[] = [];
  let y = startRow;
  let indent = 0; // the head row has no stripped indent
  for (;;) {
    const line = buffer.getLine(y);
    if (!line) break;
    const cont =
      y - startRow + 1 < MAX_LOGICAL_ROWS ? continuation(buffer, y, cols) : null;
    // Trim only the final row; strip this row's hanging indent from the left.
    rows.push(line.translateToString(!cont).slice(indent));
    indents.push(indent);
    if (!cont) break;
    indent = cont.indent;
    y++;
  }
  return { startRow, rows, indents };
}

/** 1-based xterm buffer coordinates; `end` is inclusive, per ILink.range. */
export interface BufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * Map a match's [start, end) string offsets on the JOINED logical line back to
 * buffer coordinates, splitting across the rows the link spans. A row's stripped
 * hanging indent is added back so the column lands on the real cell. Columns are
 * string offsets + 1 — the same wide-character (CJK/emoji) imprecision single-row
 * detection always had, unchanged here.
 */
export function mapRange(
  { startRow, rows, indents }: LogicalLine,
  start: number,
  end: number,
): BufferRange {
  return {
    start: toCoord(rows, indents, startRow, start),
    end: toCoord(rows, indents, startRow, end - 1),
  };
}

function toCoord(
  rows: string[],
  indents: number[],
  startRow: number,
  offset: number,
): { x: number; y: number } {
  let consumed = 0;
  for (let i = 0; i < rows.length; i++) {
    const len = rows[i].length;
    if (offset < consumed + len || i === rows.length - 1) {
      return { x: offset - consumed + indents[i] + 1, y: startRow + i + 1 };
    }
    consumed += len;
  }
  return { x: 1, y: startRow + 1 };
}
