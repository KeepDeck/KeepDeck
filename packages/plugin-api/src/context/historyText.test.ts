import { describe, expect, it } from "vitest";
import { titleText, transcriptRole, trimmedText } from "./historyText";

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

describe("titleText", () => {
  it("keeps a short title whole and cuts a long one at the index's length", () => {
    expect(titleText("fix the auth bug")).toBe("fix the auth bug");
    expect(titleText("x".repeat(500))).toHaveLength(120);
  });
});

describe("transcriptRole", () => {
  it("keeps user and assistant, and calls every other word other", () => {
    expect(transcriptRole("user")).toBe("user");
    expect(transcriptRole("assistant")).toBe("assistant");
    for (const word of ["system", "tool", "synthetic", null, undefined, 7]) {
      expect(transcriptRole(word)).toBe("other");
    }
  });
});
