import { describe, expect, it } from "vitest";
import { trimmedText } from "./historyText";

describe("trimmedText", () => {
  it("trims a string field", () => {
    expect(trimmedText("  /repo  ")).toBe("/repo");
  });

  it("is undefined for a blank string and for anything not a string", () => {
    for (const value of ["", "   \n", undefined, null, 3, {}]) {
      expect(trimmedText(value)).toBeUndefined();
    }
  });
});
