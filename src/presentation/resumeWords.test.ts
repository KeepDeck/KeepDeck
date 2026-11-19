import { describe, expect, it } from "vitest";
import type { ResumeRequest } from "../domain/deck";
import { resumeRefusalText, teamResumeRefusalText } from "./resumeWords";

describe("resumeRefusalText", () => {
  it("gives every refusal its own sentence", () => {
    expect(resumeRefusalText("running", "Agent 1")).toContain("already running");
    expect(resumeRefusalText("provisioning", "Agent 1")).toContain("worktree");
    expect(resumeRefusalText("unavailable", "Agent 1")).toContain(
      "No installed agent",
    );
    expect(resumeRefusalText("gone", "Agent 1")).toContain("no longer open");
    expect(resumeRefusalText("archived", "Agent 1")).toContain("restore the workspace first");
  });

  it("does not tell a pane mid-create that it is already running", () => {
    // The distinction the outcome type exists for: "provisioning" is not
    // "running" — a pane whose worktree is still being made has never had a
    // session, and saying otherwise is simply false.
    const text = resumeRefusalText("provisioning", "Agent 1");
    expect(text).not.toContain("running");
  });

  it("names the pane in every sentence", () => {
    // The card and the command share these words, so both have to identify
    // WHICH agent refused — the card can be one of sixteen.
    const every: Exclude<ResumeRequest, "resuming">[] = [
      "running",
      "provisioning",
      "unavailable",
      "archived",
      "gone",
    ];
    for (const outcome of every) {
      expect(resumeRefusalText(outcome, "Reviewer")).toContain("Reviewer");
    }
  });
});

describe("teamResumeRefusalText — a team's Resume refused, beside the single one", () => {
  it("says a reason every member shares in the single sentence, naming the team", () => {
    expect(teamResumeRefusalText({ kind: "archived" })).toBe(resumeRefusalText("archived", "This team"));
    expect(teamResumeRefusalText({ kind: "provisioning" })).toBe(resumeRefusalText("provisioning", "This team"));
  });

  it("tells nobody-down apart from down-but-not-coming-back, and agrees the folders with their count", () => {
    expect(teamResumeRefusalText({ kind: "none-stopped" })).toBe("No agent on this team is stopped.");
    expect(teamResumeRefusalText({ kind: "none-resumable" })).toBe("No stopped agent can be resumed right now.");
    expect(teamResumeRefusalText({ kind: "folders-gone", count: 1 })).toBe(
      "No stopped agent can be resumed — its folder is gone.",
    );
    expect(teamResumeRefusalText({ kind: "folders-gone", count: 2 })).toBe(
      "No stopped agent can be resumed — their folders are gone.",
    );
  });
});
