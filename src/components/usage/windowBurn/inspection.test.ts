import { describe, expect, it } from "vitest";
import type { BurnGeometry } from "../../../domain/usage/windowBurn";
import { burnInspectionAt } from "./inspection";

const newest = { x: 0.5, y: 0.6, at: 200, usedPct: 60 };
const projectedEnd = { x: 1, y: 1, at: 300, usedPct: 100 };
const geometry: BurnGeometry = {
  observed: [{ x: 0, y: 0.2, at: 100, usedPct: 20 }, newest],
  projected: [newest, projectedEnd],
  out: { x: 1, y: 1, level: "warn" },
  yMaxPct: 100,
  resetAtEdge: false,
};

describe("burnInspectionAt", () => {
  it("snaps observed history to a real report", () => {
    expect(burnInspectionAt(geometry, 0.49)).toEqual({
      ...newest,
      kind: "observed",
    });
  });

  it("interpolates only the projected segment and clamps its end", () => {
    expect(burnInspectionAt(geometry, 0.75)).toEqual({
      kind: "projected",
      x: 0.75,
      y: 0.8,
      at: 250,
      usedPct: 80,
    });
    expect(burnInspectionAt(geometry, 2)).toEqual({
      ...projectedEnd,
      kind: "projected",
    });
  });

  it("selects the endpoint of a collapsed projection", () => {
    const collapsedEnd = { ...projectedEnd, x: newest.x };
    expect(
      burnInspectionAt(
        { ...geometry, projected: [newest, collapsedEnd] },
        newest.x,
      ),
    ).toEqual({ ...collapsedEnd, kind: "projected" });
  });
});
