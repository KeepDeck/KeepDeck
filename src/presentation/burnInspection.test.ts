import { describe, expect, it } from "vitest";
import type { BurnGeometry } from "../domain/usage/windowBurn";
import { burnAnnouncement, burnInspectionAt, burnTooltipView, inspectedSample, NO_INSPECTION, steppedInspection } from "./burnInspection";

const newest = { x: 0.5, y: 0.6, at: 200, usedPct: 60 };
const projectedEnd = { x: 1, y: 1, at: 300, usedPct: 100 };
const geometry: BurnGeometry = {
  observed: [{ x: 0, y: 0.2, at: 100, usedPct: 20 }, newest],
  projected: [newest, projectedEnd],
  out: { x: 1, y: 1, level: "warn" },
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

describe("inspectedSample", () => {
  it("follows the pointer over the keys, the keys over focus, and shows nothing unasked", () => {
    expect(inspectedSample(geometry, { pointerX: 0.49, keyedX: 0.9, focused: true })?.at).toBe(200);
    expect(inspectedSample(geometry, { pointerX: null, keyedX: 0.75, focused: true })).toMatchObject({ kind: "projected", at: 250 });
    // Focus alone opens on the newest reading.
    expect(inspectedSample(geometry, { ...NO_INSPECTION, focused: true })).toEqual({ ...newest, kind: "observed" });
    expect(inspectedSample(geometry, NO_INSPECTION)).toBeNull();
  });
});

describe("steppedInspection", () => {
  it("walks one step from the point inspected now, never off the plot", () => {
    expect(steppedInspection(geometry, { ...NO_INSPECTION, focused: true }, 1)).toBeCloseTo(0.52);
    expect(steppedInspection(geometry, { ...NO_INSPECTION, keyedX: 0.3 }, -1)).toBeCloseTo(0.28);
    expect(steppedInspection(geometry, { ...NO_INSPECTION, keyedX: 0.99 }, 1)).toBe(1);
    expect(steppedInspection(geometry, { ...NO_INSPECTION, keyedX: 0.01 }, -1)).toBe(0);
  });
});

describe("burnTooltipView", () => {
  it("says whether the point was reported or projected, and how full", () => {
    expect(burnTooltipView({ ...newest, kind: "observed" }, "Nov 15, 21:30")).toEqual({
      kind: "observed", label: "Nov 15, 21:30", source: "Observed", value: "60% used", note: null,
    });
    expect(burnTooltipView({ ...projectedEnd, usedPct: 35.2, kind: "projected" }, "x", "a note")).toMatchObject({
      source: "Projected", value: "36% used", note: "a note",
    });
  });
});

describe("burnAnnouncement", () => {
  it("reads the card as one sentence, and nothing while nothing is inspected", () => {
    const view = burnTooltipView({ ...newest, kind: "observed" }, "Nov 15, 21:30", "This machine that day: 4k tokens");
    expect(burnAnnouncement(view)).toBe("Nov 15, 21:30: Observed, 60% used. This machine that day: 4k tokens");
    expect(burnAnnouncement({ ...view, note: null })).toBe("Nov 15, 21:30: Observed, 60% used");
    expect(burnAnnouncement(null)).toBe("");
  });
});
