import { describe, expect, it } from "vitest";
import { resumeActionView, resumeBlockReason } from "./sessionResumeView";

describe("session resume words", () => {
  it("say where a session resumes, or hold the button back with the reason", () => {
    expect(resumeActionView(null, "/repo")).toEqual({ disabled: false, title: "Resume in /repo" });
    expect(resumeActionView("elsewhere", "/repo")).toEqual({
      disabled: true,
      title: "recorded in another directory — fork a copy into this team",
    });
  });

  it("have a reason for every block and none for a resumable session", () => {
    for (const block of ["no-cwd", "claimed", "busy-outside", "dir-gone", "elsewhere"] as const) {
      expect(resumeBlockReason(block)).toBeTruthy();
    }
    expect(resumeBlockReason(null)).toBeNull();
  });
});
