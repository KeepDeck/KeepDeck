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

describe("sessionRowActionsView — what a session row offers", () => {
  const facts = {
    cwd: "/repo/wt",
    supportsResume: true,
    supportsFork: true,
    wrongOwner: false,
    live: false,
    dirPresent: true,
    team: { cwd: "/repo/wt" },
  };

  it("offers both, Resume saying where it resumes", () => {
    const view = sessionRowActionsView(facts);
    expect(view.resume).toEqual({ label: "Resume", disabled: false, title: "Resume in /repo/wt" });
    expect(view.fork?.label).toBe("Fork");
  });

  it("holds Resume back by the domain's rule — a live session, another team's directory — Fork stays", () => {
    expect(sessionRowActionsView({ ...facts, live: true }).resume).toMatchObject({
      disabled: true,
      title: "already in a pane",
    });
    expect(sessionRowActionsView({ ...facts, team: { cwd: "/repo" } }).resume).toMatchObject({ disabled: true });
    expect(sessionRowActionsView({ ...facts, team: { cwd: "/repo" } }).fork).not.toBeNull();
  });

  it("offers only what the agent supports, and nothing on a row filed under the wrong agent", () => {
    expect(sessionRowActionsView({ ...facts, supportsResume: false }).resume).toBeNull();
    expect(sessionRowActionsView({ ...facts, supportsFork: false }).fork).toBeNull();
    expect(sessionRowActionsView({ ...facts, wrongOwner: true })).toEqual({ resume: null, fork: null });
  });
});
