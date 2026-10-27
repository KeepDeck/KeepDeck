import { describe, expect, it } from "vitest";
import { firstMeaningfulUserTurn, titleText, transcriptRole, trimmedText } from "./historyText";

describe("firstMeaningfulUserTurn", () => {
  const user = (text: string) => ({ role: "user", text });

  it("skips markup and slash commands for every agent", () => {
    const turns = [user("<command-name>x</command-name>"), user("# Notes"), user("[notice]"), user("/prime"), user("fix it")];
    expect(firstMeaningfulUserTurn(turns, [])).toBe("fix it");
  });

  it("skips a declared preamble, and takes the same words as a title for an agent that declared none", () => {
    const turns = [user("Caveat: the messages below were generated"), user("real prompt")];
    expect(firstMeaningfulUserTurn(turns, ["Caveat:"])).toBe("real prompt");
    // Another CLI's user can begin a prompt with the same word.
    expect(firstMeaningfulUserTurn(turns, [])).toBe("Caveat: the messages below were generated");
  });

  it("keeps a pasted absolute path, and caps a title at 120 characters", () => {
    expect(firstMeaningfulUserTurn([user("/path/to/file — do X")], [])).toBe("/path/to/file — do X");
    expect(firstMeaningfulUserTurn([user("x".repeat(300))], [])?.length).toBeLessThanOrEqual(120);
  });
});

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
