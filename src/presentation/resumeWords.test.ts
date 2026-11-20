import { describe, expect, it } from "vitest";
import type { ResumeRequest } from "../domain/deck";
import { intentOutcomeText } from "./lifecycleWords";
import { resumeOutcomeText, resumeRefusalText, teamResumeOffer, teamResumeRefusalText } from "./resumeWords";

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

describe("resumeOutcomeText", () => {
  it("says nothing of a pane rising, the deck's sentence for its refusal, and the machine's for its own", () => {
    expect(resumeOutcomeText({ kind: "resuming" }, "Claude 1")).toBeNull();
    expect(resumeOutcomeText({ kind: "blocked", why: "archived" }, "Claude 1")).toBe(resumeRefusalText("archived", "Claude 1"));
    const unanswered = { kind: "unanswered", reply: { kind: "unavailable" } } as const;
    expect(resumeOutcomeText(unanswered, "Claude 1")).toBe(intentOutcomeText(unanswered));
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

describe("teamResumeOffer — a team's Resume as a door offers it", () => {
  it("names it by the stopped agents it asks back, agreeing the noun with the count", () => {
    expect(teamResumeOffer({ take: ["a"] })).toBe("Resume 1 stopped agent");
    expect(teamResumeOffer({ take: ["a", "b", "c", "d"] })).toBe("Resume 4 stopped agents");
  });

  it("offers nothing when it would take nobody", () => {
    expect(teamResumeOffer({ take: [] })).toBeNull();
  });
});
