import { describe, expect, it } from "vitest";
import type { ResumeRequest } from "./agentOrchestrator";
import { resumeRefusalText } from "./resumeOutcome";

describe("resumeRefusalText", () => {
  it("gives every refusal its own sentence", () => {
    expect(resumeRefusalText("running", "Agent 1")).toContain("already running");
    expect(resumeRefusalText("provisioning", "Agent 1")).toContain("worktree");
    expect(resumeRefusalText("unavailable", "Agent 1")).toContain(
      "No installed agent",
    );
    expect(resumeRefusalText("gone", "Agent 1")).toContain("no longer open");
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
      "gone",
    ];
    for (const outcome of every) {
      expect(resumeRefusalText(outcome, "Reviewer")).toContain("Reviewer");
    }
  });
});
