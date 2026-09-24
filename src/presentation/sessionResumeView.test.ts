import { describe, expect, it } from "vitest";
import { resumeActionView, resumeBlockReason, sessionRowActionsView } from "./sessionResumeView";

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

describe("sessionRowActionsView — the domain's offer, in words", () => {
  it("labels each action offered, Resume saying where it resumes or why it is held back", () => {
    expect(sessionRowActionsView({ resume: { block: null }, fork: true }, "/repo/wt")).toEqual({
      resume: { label: "Resume", disabled: false, title: "Resume in /repo/wt" },
      fork: { label: "Fork", title: "Fork — a new conversation continuing from this session" },
    });
    expect(sessionRowActionsView({ resume: { block: "claimed" }, fork: false }, "/x")).toEqual({
      resume: { label: "Resume", disabled: true, title: "already in a pane" },
      fork: null,
    });
    expect(sessionRowActionsView({ resume: null, fork: false }, "/x")).toEqual({ resume: null, fork: null });
  });
});
