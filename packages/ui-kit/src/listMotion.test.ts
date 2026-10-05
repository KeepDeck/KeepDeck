import { describe, expect, it } from "vitest";
import { marksOf } from "./listMotion";

describe("marksOf — what one change of the rows is", () => {
  it("moves the person's change, and holds the item it happened after", () => {
    expect(marksOf(["h0", "h1", "h2"], ["h0", "h1", "r0", "r1", "h2"], true)).toEqual({ eased: true, held: "h1" });
    expect(marksOf(["h0", "r0", "h1"], ["h0", "h1"], true)).toEqual({ eased: true, held: "h0" });
  });

  it("lands any other change still, holding nothing", () => {
    expect(marksOf(["h0", "r0"], ["r0", "h0"], false)).toEqual({ eased: false, held: null });
    expect(marksOf(["h0", "r0"], ["h0", "r0"], false)).toEqual({ eased: false, held: null });
  });
});
