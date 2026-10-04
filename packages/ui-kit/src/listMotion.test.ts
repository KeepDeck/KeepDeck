import { describe, expect, it } from "vitest";
import { motionOf } from "./listMotion";

describe("motionOf — what one change of the rows marks", () => {
  const none = { arriving: null, held: null };

  it("eases in the rows the person's change brought, and holds the item it happened after", () => {
    const marks = motionOf(["h0", "h1", "h2"], ["h0", "h1", "r0", "r1", "h2"], true, none);
    expect(marks).toEqual({ arriving: new Set(["r0", "r1"]), held: "h1" });
  });

  it("holds the heading a fold shut, with nothing arriving", () => {
    expect(motionOf(["h0", "r0", "h1"], ["h0", "h1"], true, none)).toEqual({ arriving: new Set(), held: "h0" });
  });

  it("lets a standing entrance run out through the same rows again — but holds nothing twice", () => {
    const standing = { arriving: new Set(["r0"]), held: "h0" };
    expect(motionOf(["h0", "r0"], ["h0", "r0"], false, standing)).toEqual({ arriving: standing.arriving, held: null });
  });

  it("marks nothing for a change that was not the person's", () => {
    const standing = { arriving: new Set(["r0"]), held: "h0" };
    expect(motionOf(["h0", "r0"], ["r0", "h0"], false, standing)).toEqual(none);
  });
});
