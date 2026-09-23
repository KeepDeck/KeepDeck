import { describe, expect, it } from "vitest";
import { resumeBlock, type ResumeFacts } from "./sessionResume";

const free: ResumeFacts = { cwd: "/repo/wt", claimed: false, busyOutside: false, dirPresent: true };

describe("resumeBlock — whether a session resumes onto a team", () => {
  it("resumes a free session recorded in the team's directory, the same key whatever the trailing slash", () => {
    expect(resumeBlock(free, { cwd: "/repo/wt" })).toBeNull();
    expect(resumeBlock({ ...free, cwd: "/repo/wt/" }, { cwd: "/repo/wt" })).toBeNull();
  });

  it("holds back a session recorded elsewhere, or for a team whose directory is not there yet", () => {
    expect(resumeBlock(free, { cwd: "/repo" })).toBe("elsewhere");
    expect(resumeBlock(free, { cwd: null })).toBe("elsewhere");
  });

  it("asks nothing of a directory when no team is asking", () => {
    expect(resumeBlock(free, null)).toBeNull();
  });

  it("names what stops it, the first that applies", () => {
    expect(resumeBlock({ ...free, cwd: "" }, null)).toBe("no-cwd");
    expect(resumeBlock({ ...free, claimed: true, busyOutside: true }, null)).toBe("claimed");
    expect(resumeBlock({ ...free, busyOutside: true, dirPresent: false }, null)).toBe("busy-outside");
    expect(resumeBlock({ ...free, dirPresent: false }, { cwd: "/elsewhere" })).toBe("dir-gone");
  });
});
