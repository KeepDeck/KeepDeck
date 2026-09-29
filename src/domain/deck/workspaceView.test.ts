import { describe, expect, it } from "vitest";
import { backToCards } from "./workspaceView";

describe("backToCards", () => {
  it("closes the team and drops the highlight, keeping the spotlight and the rest", () => {
    const next = backToCards(
      { a: { teamOpen: "t", select: "p1", focus: "p1", dock: true }, b: { teamOpen: "u" } },
      "a",
    );
    expect(next).toEqual({ a: { focus: "p1", dock: true }, b: { teamOpen: "u" } });
  });

  it("prunes a view left with nothing in it", () => {
    expect(backToCards({ a: { teamOpen: "t", select: "p1" } }, "a")).toEqual({});
  });
});
