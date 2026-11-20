import { describe, expect, it } from "vitest";
import type { SuspendOutcome } from "../domain/deck";
import { intentOutcomeText } from "./lifecycleWords";
import { suspendRefusalText, suspendResultText, teamSuspendRefusalText } from "./suspendWords";

describe("suspendRefusalText", () => {
  it("gives every refusal its own sentence", () => {
    // One wording, shared by the hotkey, the command and the close dialog —
    // the whole reason the outcome is a reason and not a boolean.
    expect(suspendRefusalText("stopped", "Agent 1")).toContain("already stopped");
    expect(suspendRefusalText("provisioning", "Agent 1")).toContain("worktree");
    expect(suspendRefusalText("in-flight", "Agent 1")).toContain(
      "already being suspended",
    );
    expect(suspendRefusalText("gone", "Agent 1")).toContain("no longer open");
  });

  it("tells a remote pane's user the truth about where its session lives", () => {
    // The sentence this type exists for: the earlier boolean made one surface
    // claim a running remote agent had no session to stop.
    const text = suspendRefusalText("remote", "Agent 1");
    expect(text).toContain("remote server");
    expect(text).not.toContain("no session");
  });

  it("names the pane in every sentence", () => {
    const every: Exclude<SuspendOutcome, "suspended">[] = [
      "stopped",
      "provisioning",
      "remote",
      "in-flight",
      "gone",
    ];
    for (const outcome of every) {
      expect(suspendRefusalText(outcome, "Reviewer")).toContain("Reviewer");
    }
  });
});

describe("suspendResultText", () => {
  it("says nothing of a suspend under way, the deck's sentence for its refusal, and the machine's for its own", () => {
    expect(suspendResultText({ kind: "suspending" }, "Claude 1")).toBeNull();
    expect(suspendResultText({ kind: "blocked", why: "remote" }, "Claude 1")).toBe(suspendRefusalText("remote", "Claude 1"));
    const refused = { kind: "refused", refusal: { kind: "targetLeaving" } } as const;
    expect(suspendResultText(refused, "Claude 1")).toBe(intentOutcomeText(refused));
  });
});

describe("teamSuspendRefusalText — a team's Suspend refused, beside the single one", () => {
  it("says a reason one pane shares with the team in the single sentence, naming the team", () => {
    expect(teamSuspendRefusalText("provisioning")).toBe(suspendRefusalText("provisioning", "This team"));
    expect(teamSuspendRefusalText("in-flight")).toBe(suspendRefusalText("in-flight", "This team"));
  });

  it("says the team's own reasons of its running agents, in their number", () => {
    expect(teamSuspendRefusalText("stopped")).toBe("Nothing on this team is running.");
    expect(teamSuspendRefusalText("remote")).toBe(
      "Its running agents run on a remote server — stopping the local client would not park them.",
    );
  });
});
