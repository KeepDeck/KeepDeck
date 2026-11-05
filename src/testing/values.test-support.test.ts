import { describe, expect, it, vi } from "vitest";
import { edgeTimes, statusEdge, usageResult } from "./values.test-support";

describe("payload readers", () => {
  it("answer null for a shape they do not own", () => {
    expect(usageResult({ result: { account: null, pane: null } })).toEqual({
      account: null,
      pane: null,
    });
    expect(usageResult({ result: 3 })).toBeNull();
    expect(usageResult(null)).toBeNull();
    expect(statusEdge({ edge: { kind: "turn-start", at: 1 } })).toEqual({
      kind: "turn-start",
      at: 1,
    });
    expect(statusEdge({ edge: { kind: "turn-start" } })).toBeNull();
    expect(statusEdge(null)).toBeNull();
  });
});

describe("edgeTimes", () => {
  it("hands out times in order from one reading, whatever the wall clock does next", () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const next = edgeTimes();
      wall.mockReturnValue(900);
      expect([next(), next(), next()]).toEqual([1_000, 1_001, 1_002]);
    } finally {
      wall.mockRestore();
    }
  });
});
