import { describe, expect, it } from "vitest";
import { troubleText } from "./troubleView";

describe("troubleText", () => {
  it("words each state for a person, and hands git's own line through otherwise", () => {
    expect(troubleText({ kind: "not-repo" })).toBe("Not a git repository.");
    expect(troubleText({ kind: "no-git" })).toContain("git is not installed");
    expect(troubleText({ kind: "no-commits" })).toBe("No commits yet.");
    expect(troubleText({ kind: "out-of-scope" })).toContain("Outside the workspace");
    expect(troubleText({ kind: "failed", detail: "bad object deadbeef" })).toBe(
      "bad object deadbeef",
    );
  });
});
