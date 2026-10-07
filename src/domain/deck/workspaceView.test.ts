import { describe, expect, it } from "vitest";
import { backToCards, setViewField } from "./workspaceView";

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

describe("setViewField", () => {
  it("keeps a view that still holds folded epics or a newer revision's fields when its last other field goes", () => {
    expect(setViewField({ a: { select: "p1", foldedEpics: ["u-1"] } }, "a", "select", undefined)).toEqual({ a: { foldedEpics: ["u-1"] } });
    expect(setViewField({ a: { select: "p1", extras: { future: 1 } } }, "a", "select", undefined)).toEqual({ a: { extras: { future: 1 } } });
    expect(setViewField({ a: { select: "p1" } }, "a", "select", undefined)).toEqual({});
  });
});
