import { describe, expect, it } from "vitest";
import { statusEdge, usageResult } from "./values.test-support";

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
