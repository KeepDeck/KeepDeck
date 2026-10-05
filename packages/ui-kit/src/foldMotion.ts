/**
 * A person's fold, as the LIST paints it — the rule of the list's motion,
 * pure (design: artifact `list-motion-design`).
 *
 * The layout is final the moment the person folds: the queue, the
 * virtualizer's measurements, the anchoring and the hold all act on the
 * new rows at once, and nothing here ever feeds a size back into them.
 * What moves is the PAINT between the two layouts. A fold changes the
 * layout at a few places only — each a run of rows that joined (a group
 * opened) or left (a group shut) between two rows that stayed — so the
 * motion is a short list of SEGMENTS, and where anything is drawn at a
 * moment follows from them in closed form:
 *
 * - a row that stayed is drawn at its final start, less what the runs
 *   above it have yet to grow (`residual × delta`);
 * - a run's rows are drawn inside ONE clipping box that starts under the
 *   row before the run, at their offset within the run, the box's height
 *   going from the run's old size to its new — the group unrolls from
 *   under its heading, or rolls up into it;
 * - a row that left (a GHOST) is drawn at its OLD offset within the run.
 *
 * Every final position is read from the LIVE layout each time, and a
 * segment is named by the keys around its run, so a re-measure, or an
 * agent's change landing mid-motion, simply paints into the new layout —
 * nothing to rebase by hand.
 */

/** One row of a layout, in index order: its key and where it lies. */
export interface LaidRow {
  key: string;
  start: number;
  end: number;
}

/** A layout as the motion asks it: its rows in order, and its height. */
export interface Layout {
  rows: readonly LaidRow[];
  total: number;
}

/** A row that left, as it stood in its run before the change. */
export interface Ghost {
  key: string;
  /** Its offset from the top of the run, in the OLD layout. */
  local: number;
  size: number;
}

/** One place the rows changed: the run between two rows that stayed. */
export interface FoldSegment {
  /** The row just above the run — the heading folded — or null at the
   * top of the list. */
  pivot: string | null;
  /** The row just below the run, or null at the end of the list. */
  boundary: string | null;
  /** How tall the run was before the change. */
  oldSize: number;
  ghosts: readonly Ghost[];
}

/**
 * The segments one change of the rows makes, from the layout before to
 * the layout after — or null when the rows that stayed did not keep their
 * order (a reorder is no fold, and is not painted as one).
 */
export function segmentsOf(before: Layout, after: Layout): FoldSegment[] | null {
  const kept = new Set(after.rows.map((row) => row.key));
  const had = new Set(before.rows.map((row) => row.key));
  const oldEnd = new Map(before.rows.map((row) => [row.key, row.end]));
  const oldStart = new Map(before.rows.map((row) => [row.key, row.start]));
  const segments: FoldSegment[] = [];
  const b = before.rows;
  const a = after.rows;
  let i = 0;
  let j = 0;
  let pivot: string | null = null;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i].key === a[j].key) {
      pivot = b[i].key;
      i++;
      j++;
      continue;
    }
    const leaving: LaidRow[] = [];
    while (i < b.length && !kept.has(b[i].key)) leaving.push(b[i++]);
    let entered = false;
    while (j < a.length && !had.has(a[j].key)) {
      entered = true;
      j++;
    }
    // Past the run, both lists must stand on the same row again.
    const boundary = i < b.length ? b[i].key : null;
    const resumes = j < a.length ? a[j].key : null;
    if ((leaving.length === 0 && !entered) || boundary !== resumes) return null;
    const runStart = pivot === null ? 0 : oldEnd.get(pivot)!;
    const runEnd = boundary === null ? before.total : oldStart.get(boundary)!;
    segments.push({
      pivot,
      boundary,
      oldSize: runEnd - runStart,
      ghosts: leaving.map((row) => ({ key: row.key, local: row.start - runStart, size: row.end - row.start })),
    });
  }
  return segments;
}

/** How far along a motion is, eased: the list's disclosure curve. */
export function easeFold(t: number): number {
  const p = Math.min(1, Math.max(0, t));
  return 1 - (1 - p) ** 3;
}

/** A segment placed in the live layout: where its run starts and ends,
 * and how much it grows. */
interface PlacedSegment {
  index: number;
  runStart: number;
  runEnd: number;
  delta: number;
  oldSize: number;
  ghosts: readonly Ghost[];
}

/** The segments as they lie in `layout`, top-down — a segment whose pivot
 * or boundary is no longer there is dropped (its run's place is gone). */
function placed(segments: readonly FoldSegment[], layout: Layout): PlacedSegment[] {
  const at = new Map(layout.rows.map((row) => [row.key, row]));
  const out: PlacedSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const pivot = segment.pivot === null ? null : at.get(segment.pivot);
    const boundary = segment.boundary === null ? null : at.get(segment.boundary);
    if (pivot === undefined || boundary === undefined) continue;
    const runStart = pivot === null ? 0 : pivot.end;
    const runEnd = boundary === null ? layout.total : boundary.start;
    out.push({ index, runStart, runEnd, delta: runEnd - runStart - segment.oldSize, oldSize: segment.oldSize, ghosts: segment.ghosts });
  }
  return out.sort((x, y) => x.runStart - y.runStart);
}

/** The part of the list in view, and how far beyond it rows are mounted. */
export interface Viewport {
  top: number;
  height: number;
  overscan: number;
}

/** What one frame of a motion draws. */
export interface FoldFrame {
  /** The rows of the final layout to mount, in index order: a row that
   * stayed is drawn at `top` on the spacer; a row of a run (`box` set) at
   * `top` within that segment's box. */
  rows: { index: number; key: string; top: number; box: number | null }[];
  /** One clipping box per segment still placed — where it starts on the
   * spacer, how tall it is — keyed by the segment's position in the
   * motion. */
  boxes: { segment: number; top: number; height: number }[];
  /** The rows that left, still drawn: within their segment's box. */
  ghosts: { segment: number; key: string; top: number }[];
  /** The painted height of everything. */
  total: number;
  /** Every drawn thing as the pinned heading reads it: the index of the
   * row it belongs to (a ghost: its segment's pivot), and where it is on
   * the spacer, in order. */
  occupancy: { index: number; start: number; end: number }[];
}

/**
 * One frame of a motion — each segment `residuals[i]` of the way from the
 * final layout back to the old one (1 at its start, 0 at its end; folds
 * made one after another run on their own clocks): what to mount, where
 * to draw it. Only what meets `view` (plus its overscan) is mounted — chosen
 * by where it is DRAWN, not by where the final layout puts it, or a long
 * opening would paint an empty viewport.
 */
export function foldFrame(
  segments: readonly FoldSegment[],
  layout: Layout,
  residuals: readonly number[],
  view: Viewport,
): FoldFrame {
  const runs = placed(segments, layout);
  const low = view.top - view.overscan;
  const high = view.top + view.height + view.overscan;
  const meets = (top: number, bottom: number) => bottom > low && top < high;
  // Each run's box: under the row before it, displaced by what the runs
  // above it have yet to grow; as tall as the run is at this moment.
  const boxes: FoldFrame["boxes"] = [];
  let above = 0;
  for (const run of runs) {
    const residual = residuals[run.index] ?? 0;
    boxes.push({ segment: run.index, top: run.runStart - above, height: run.runEnd - run.runStart - residual * run.delta });
    above += residual * run.delta;
  }
  const rows: FoldFrame["rows"] = [];
  const occupancy: FoldFrame["occupancy"] = [];
  let next = 0;
  let shift = 0;
  for (const [index, row] of layout.rows.entries()) {
    // Runs wholly above this row have moved it by what they have yet to grow.
    while (next < runs.length && runs[next].runEnd <= row.start) {
      shift += (residuals[runs[next].index] ?? 0) * runs[next].delta;
      next++;
    }
    const run = next < runs.length && runs[next].runStart <= row.start && row.start < runs[next].runEnd ? next : -1;
    if (run >= 0) {
      const box = boxes[run];
      const local = row.start - runs[run].runStart;
      // Inside its box, and the box's visible part, and the view.
      if (local < box.height && meets(box.top + local, box.top + local + row.end - row.start)) {
        rows.push({ index, key: row.key, top: local, box: box.segment });
        occupancy.push({ index, start: box.top + local, end: box.top + Math.min(box.height, local + row.end - row.start) });
      }
      continue;
    }
    const top = row.start - shift;
    if (meets(top, top + row.end - row.start)) {
      rows.push({ index, key: row.key, top, box: null });
      occupancy.push({ index, start: top, end: top + row.end - row.start });
    }
  }
  const ghosts: FoldFrame["ghosts"] = [];
  const pivotIndex = new Map(layout.rows.map((row, index) => [row.key, index]));
  for (const [at, run] of runs.entries()) {
    const box = boxes[at];
    const owner = segments[run.index].pivot === null ? -1 : (pivotIndex.get(segments[run.index].pivot!) ?? -1);
    for (const ghost of run.ghosts) {
      if (ghost.local >= box.height || !meets(box.top + ghost.local, box.top + ghost.local + ghost.size)) continue;
      ghosts.push({ segment: run.index, key: ghost.key, top: ghost.local });
      if (owner >= 0) occupancy.push({ index: owner, start: box.top + ghost.local, end: box.top + Math.min(box.height, ghost.local + ghost.size) });
    }
  }
  occupancy.sort((x, y) => x.start - y.start);
  const still = runs.reduce((sum, run) => sum + (residuals[run.index] ?? 0) * run.delta, 0);
  return { rows, boxes, ghosts, total: layout.total - still, occupancy };
}

/** The spacer's height during a fold: as tall as what is drawn, and never
 * shorter than the scroll needs — or the browser would clamp the walk. */
export function foldSpacer(frame: FoldFrame, scrollTop: number, viewportHeight: number): number {
  return Math.max(frame.total, scrollTop + viewportHeight);
}

/** One segment of a fold in flight: how much of it was left to play when
 * its clock started (1 for a fresh fold; less for one turned back). */
export interface FoldPart {
  segment: FoldSegment;
  from: number;
}

/**
 * The parts a new fold makes, given the parts still playing and how far
 * each has yet to go (`playing[i].residual`). A segment of the same place
 * — the same group folded back before its fold has ended — takes over
 * from where the one playing has got to: it starts with what that one
 * has already done (1 − its residual), so a quick toggle turns the group
 * round mid-way instead of snapping it shut or open first. Every other
 * part playing goes on; a new place starts fresh.
 */
export function mergeFolds(
  playing: readonly { segment: FoldSegment; residual: number }[],
  next: readonly FoldSegment[],
): { kept: number[]; added: FoldPart[] } {
  const turned = new Set<number>();
  const added = next.map((segment): FoldPart => {
    const at = playing.findIndex(
      (part, index) => !turned.has(index) && part.segment.pivot === segment.pivot && part.segment.boundary === segment.boundary,
    );
    if (at < 0) return { segment, from: 1 };
    turned.add(at);
    return { segment, from: 1 - playing[at].residual };
  });
  return { kept: playing.map((_, index) => index).filter((index) => !turned.has(index)), added };
}

/** Where the person's scroll walk stands, `eased` of the way from where
 * it was to where the fold put it. */
export function walkAt(from: number, to: number, eased: number): number {
  return from + (to - from) * eased;
}

/** A walk's target as the browser can reach it: within the list. */
export function reachable(target: number, total: number, viewportHeight: number): number {
  return Math.max(0, Math.min(target, total - viewportHeight));
}
