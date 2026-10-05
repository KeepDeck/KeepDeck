import { describe, expect, it } from "vitest";
import { easeFold, foldFrame, foldSpacer, mergeFolds, reachable, segmentsOf, walkAt, type Layout } from "./foldMotion";

/** A layout of rows, each `h` tall unless given, laid end to end. */
const laid = (rows: (string | [string, number])[], h = 10): Layout => {
  let at = 0;
  const out = rows.map((row) => {
    const [key, size] = typeof row === "string" ? [row, h] : row;
    const start = at;
    at += size;
    return { key, start, end: at };
  });
  return { rows: out, total: at };
};

const VIEW = { top: 0, height: 1000, overscan: 0 };

/** Every segment of a fold at the same residual. */
const all = (segments: readonly unknown[], residual: number) => segments.map(() => residual);

describe("segmentsOf — where a fold changed the rows", () => {
  it("finds an opening between its heading and the next row, and a shut with its ghosts at their old offsets", () => {
    const shut = laid(["A", "B", "C"]);
    const open = laid(["A", "a1", "a2", "B", "C"]);
    expect(segmentsOf(shut, open)).toEqual([{ pivot: "A", boundary: "B", oldSize: 0, ghosts: [] }]);
    expect(segmentsOf(open, shut)).toEqual([
      {
        pivot: "A",
        boundary: "B",
        oldSize: 20,
        ghosts: [
          { key: "a1", local: 0, size: 10 },
          { key: "a2", local: 10, size: 10 },
        ],
      },
    ]);
  });

  it("finds every place at once — collapse all — and runs at the very top or end", () => {
    const before = laid(["x", "A", "a1", "B", "b1", "b2"]);
    const after = laid(["A", "B"]);
    expect(segmentsOf(before, after)!.map((s) => [s.pivot, s.boundary, s.oldSize])).toEqual([
      [null, "A", 10],
      ["A", "B", 10],
      ["B", null, 20],
    ]);
  });

  it("is no fold when the rows that stayed changed their order", () => {
    expect(segmentsOf(laid(["A", "B", "C"]), laid(["B", "A", "C"]))).toBeNull();
  });
});

describe("foldFrame — one frame of a fold", () => {
  const shut = laid(["A", "B", "C"]);
  const open = laid(["A", "a1", "a2", "B", "C"]);
  const opening = segmentsOf(shut, open)!;

  it("opens under the heading: the box grows from nothing, what is below slides from where it stood", () => {
    const start = foldFrame(opening, open, all(opening, 1), VIEW);
    expect(start.boxes).toEqual([{ segment: 0, top: 10, height: 0 }]);
    expect(start.rows.map((r) => [r.key, r.top, r.box])).toEqual([
      ["A", 0, null],
      ["B", 10, null],
      ["C", 20, null],
    ]);
    expect(start.total).toBe(30);
    const half = foldFrame(opening, open, all(opening, 0.5), VIEW);
    expect(half.boxes[0].height).toBe(10);
    // The group's TOP row shows first; the next stays clipped below the frontier.
    expect(half.rows.map((r) => [r.key, r.top, r.box])).toEqual([
      ["A", 0, null],
      ["a1", 0, 0],
      ["B", 20, null],
      ["C", 30, null],
    ]);
    const end = foldFrame(opening, open, all(opening, 0), VIEW);
    expect(end.rows.map((r) => [r.key, r.top])).toEqual([
      ["A", 0],
      ["a1", 0],
      ["a2", 10],
      ["B", 30],
      ["C", 40],
    ]);
    expect(end.total).toBe(50);
  });

  it("shuts into the heading: its rows stay as ghosts at their old offsets, the box rolling up over them", () => {
    const shutting = segmentsOf(open, shut)!;
    const half = foldFrame(shutting, shut, all(shutting, 0.5), VIEW);
    expect(half.boxes).toEqual([{ segment: 0, top: 10, height: 10 }]);
    expect(half.ghosts).toEqual([{ segment: 0, key: "a1", top: 0 }]);
    expect(half.rows.map((r) => [r.key, r.top])).toEqual([
      ["A", 0],
      ["B", 20],
      ["C", 30],
    ]);
    expect(foldFrame(shutting, shut, all(shutting, 0), VIEW).ghosts).toEqual([]);
  });

  it("carries a lower heading by what the folds above it have yet to grow (reviewer-3: 30, 75, 120)", () => {
    // A opens 90 above B; B opens 60 under itself. B's final start is 120.
    const before = laid([["A", 30], ["B", 30], ["C", 30]]);
    const after = laid([["A", 30], ["a", 90], ["B", 30], ["b", 60], ["C", 30]]);
    const motion = segmentsOf(before, after)!;
    const top = (residual: number) => foldFrame(motion, after, all(motion, residual), VIEW).rows.find((r) => r.key === "B")!.top;
    expect([top(1), top(0.5), top(0)]).toEqual([30, 75, 120]);
    // B's box starts under B as it is DRAWN.
    expect(foldFrame(motion, after, all(motion, 0.5), VIEW).boxes[1].top).toBe(105);
  });

  it("draws a lower shut's ghosts inside its own box (reviewer-3: two shuts, 150 and 105)", () => {
    const before = laid([["A", 30], ["a", 90], ["B", 30], ["b", 60], ["C", 30]]);
    const after = laid([["A", 30], ["B", 30], ["C", 30]]);
    const motion = segmentsOf(before, after)!;
    const ghostAt = (residual: number) => {
      const frame = foldFrame(motion, after, all(motion, residual), VIEW);
      const ghost = frame.ghosts.find((g) => g.key === "b")!;
      return frame.boxes.find((b) => b.segment === ghost.segment)!.top + ghost.top;
    };
    expect([ghostAt(1), ghostAt(0.5)]).toEqual([150, 105]);
  });

  it("mounts what is DRAWN in view — a long opening never paints an empty viewport", () => {
    const keys = Array.from({ length: 100 }, (_, i) => `r${i}`);
    const after = laid(["A", ...keys, "B", ...Array.from({ length: 100 }, (_, i) => `s${i}`)]);
    const before = laid(["A", "B", ...Array.from({ length: 100 }, (_, i) => `s${i}`)]);
    const motion = segmentsOf(before, after)!;
    const view = { top: 0, height: 200, overscan: 0 };
    for (const residual of [1, 0.5, 0]) {
      const frame = foldFrame(motion, after, all(motion, residual), view);
      const drawn = frame.occupancy.filter((o) => o.end > 0 && o.start < 200);
      const covered = drawn.reduce((sum, o) => sum + Math.min(o.end, 200) - Math.max(o.start, 0), 0);
      expect(covered, `residual ${residual}`).toBe(200);
      expect(frame.rows.length).toBeLessThan(30);
    }
  });

  it("tells the pinned heading a ghost belongs to the group shutting", () => {
    const shutting = segmentsOf(open, shut)!;
    const frame = foldFrame(shutting, shut, all(shutting, 0.5), VIEW);
    expect(frame.occupancy.map((o) => [o.index, o.start])).toEqual([
      [0, 0],
      [0, 10],
      [1, 20],
      [2, 30],
    ]);
  });

  it("paints into the live layout: a row an agent adds mid-motion is simply there", () => {
    const shutting = segmentsOf(open, shut)!;
    const later = laid(["A", "B", "X", "C"]);
    expect(foldFrame(shutting, later, all(shutting, 0), VIEW).rows.map((r) => r.key)).toEqual(["A", "B", "X", "C"]);
    // A segment whose heading is gone is dropped, not painted wrong.
    expect(foldFrame(shutting, laid(["B", "C"]), all(shutting, 0.5), VIEW).boxes).toEqual([]);
  });
});

describe("the walk and the curve", () => {
  it("eases out, ends where it should, and never leaves the list", () => {
    expect([easeFold(0), easeFold(1), easeFold(2)]).toEqual([0, 1, 1]);
    expect(easeFold(0.5)).toBeGreaterThan(0.5);
    expect(walkAt(100, 40, 0.5)).toBe(70);
    expect(reachable(900, 1000, 300)).toBe(700);
    expect(reachable(-5, 1000, 300)).toBe(0);
  });
});

describe("mergeFolds — a fold made while another plays", () => {
  const open = laid(["A", "a1", "a2", "B", "C"]);
  const shut = laid(["A", "B", "C"]);
  const opening = segmentsOf(shut, open)![0];
  const shutting = segmentsOf(open, shut)![0];

  it("turns the same group round from where it has got to — no snap shut or open first", () => {
    // Opening, 30% left to go: shutting it now starts 70% of the way.
    const merged = mergeFolds([{ segment: opening, residual: 0.3 }], [shutting]);
    expect(merged).toEqual({ kept: [], added: [{ segment: shutting, from: 0.7 }] });
    // And it draws the very box the opening had: 70% of the group.
    const before = foldFrame([opening], open, [0.3], VIEW).boxes[0].height;
    const after = foldFrame([shutting], shut, [0.7], VIEW).boxes[0].height;
    expect(after).toBeCloseTo(before);
  });

  it("lets a fold elsewhere play on beside the new one", () => {
    const other = segmentsOf(laid(["A", "B", "C"]), laid(["A", "B", "b1", "C"]))![0];
    expect(mergeFolds([{ segment: opening, residual: 0.3 }], [other])).toEqual({ kept: [0], added: [{ segment: other, from: 1 }] });
  });
});

describe("foldSpacer", () => {
  it("is as tall as what is drawn, and never shorter than the walk needs", () => {
    const frame = foldFrame([], laid(["A", "B"]), [], VIEW);
    expect(foldSpacer(frame, 0, 10)).toBe(20);
    expect(foldSpacer(frame, 15, 10)).toBe(25);
  });
});
