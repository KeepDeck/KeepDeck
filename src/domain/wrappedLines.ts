/**
 * Reassemble xterm's wrapped buffer rows into logical lines, so link detection
 * ([F10]/[F14]) sees a whole URL/path even when the terminal wrapped it. xterm
 * stores one long output line as several buffer rows with `isWrapped` set on
 * every continuation row; scanning rows one by one matches only fragments
 * (a wrapped link's tail looks like a relative path on its own).
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
}

/**
 * Rows a logical line may span before the walk gives up extending. A cap keeps
 * a pathological line (minified JS dumped to the terminal) from turning every
 * hover into a giant regex scan; links crossing the cut stay fragments, like
 * xterm's own web-links addon under its scan cap.
 */
export const MAX_LOGICAL_ROWS = 64;

/**
 * Collect the logical line containing buffer row `row` (0-based): walk up to
 * the first non-wrapped row, then down while continuations follow. Non-final
 * rows keep their trailing whitespace (`translateToString(false)`) — a genuine
 * space at the wrap column separates tokens, and trimming it would glue
 * `error in ` + `/path` into `in/path`; only the final row is right-trimmed,
 * matching what single-row detection did. Null when `row` isn't in the buffer.
 */
export function logicalLineAt(
  buffer: WrappedBufferLike,
  row: number,
): LogicalLine | null {
  if (!buffer.getLine(row)) return null;

  let startRow = row;
  while (
    row - startRow < MAX_LOGICAL_ROWS - 1 &&
    buffer.getLine(startRow)?.isWrapped &&
    buffer.getLine(startRow - 1)
  ) {
    startRow--;
  }

  const rows: string[] = [];
  let y = startRow;
  for (;;) {
    const line = buffer.getLine(y);
    if (!line) break;
    const next = y - startRow + 1 < MAX_LOGICAL_ROWS ? buffer.getLine(y + 1) : undefined;
    const continues = next?.isWrapped === true;
    rows.push(line.translateToString(!continues));
    if (!continues) break;
    y++;
  }
  return { startRow, rows };
}

/** 1-based xterm buffer coordinates; `end` is inclusive, per ILink.range. */
export interface BufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * Map a match's [start, end) string offsets on the JOINED logical line back to
 * buffer coordinates, splitting across the rows the link spans. Columns are
 * string offsets + 1 — the same wide-character (CJK/emoji) imprecision
 * single-row detection always had, unchanged here.
 */
export function mapRange(
  { startRow, rows }: LogicalLine,
  start: number,
  end: number,
): BufferRange {
  return {
    start: toCoord(rows, startRow, start),
    end: toCoord(rows, startRow, end - 1),
  };
}

function toCoord(
  rows: string[],
  startRow: number,
  offset: number,
): { x: number; y: number } {
  let consumed = 0;
  for (let i = 0; i < rows.length; i++) {
    const len = rows[i].length;
    if (offset < consumed + len || i === rows.length - 1) {
      return { x: offset - consumed + 1, y: startRow + i + 1 };
    }
    consumed += len;
  }
  return { x: 1, y: startRow + 1 };
}
