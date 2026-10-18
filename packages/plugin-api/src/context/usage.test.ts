import { describe, expect, it } from "vitest";
import { parseJsonRecord, percentWindow, reportedLimits } from "./usage";

describe("percentWindow", () => {
  it("normalizes a percentage window, reset seconds → ms", () => {
    expect(
      percentWindow({ usedPct: 42.5, resetsAtSeconds: 1_792_360_000, windowMinutes: 300 }),
    ).toEqual({ usedPct: 42.5, resetsAt: 1_792_360_000_000, windowMinutes: 300 });
  });

  it("clamps the percentage and carries a scope only when given", () => {
    expect(
      percentWindow({ usedPct: 140, resetsAtSeconds: undefined, windowMinutes: null, scope: "opus" }),
    ).toEqual({ usedPct: 100, resetsAt: null, windowMinutes: null, scope: "opus" });
    expect(
      percentWindow({ usedPct: -3, resetsAtSeconds: "soon", windowMinutes: 10080 }),
    ).toEqual({ usedPct: 0, resetsAt: null, windowMinutes: 10080 });
  });

  it("is null without a usable percentage", () => {
    expect(percentWindow({ usedPct: undefined, resetsAtSeconds: 1, windowMinutes: 300 })).toBeNull();
    expect(percentWindow({ usedPct: "50", resetsAtSeconds: 1, windowMinutes: 300 })).toBeNull();
  });
});

describe("reportedLimits", () => {
  it("claims the windows as of `at`, leaving the source pane to the host", () => {
    const windows = [{ usedPct: 10, resetsAt: null, windowMinutes: 300 }];
    expect(reportedLimits(windows, 1234)).toEqual({
      kind: "reported",
      windows,
      reportedAt: 1234,
      sourcePaneId: "",
    });
  });
});

describe("parseJsonRecord", () => {
  it("returns a JSON object", () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
  });

  it("is null for broken JSON and for JSON that is not an object", () => {
    expect(parseJsonRecord("{ broken")).toBeNull();
    expect(parseJsonRecord("[1,2]")).toBeNull();
    expect(parseJsonRecord("null")).toBeNull();
    expect(parseJsonRecord('"text"')).toBeNull();
  });
});
