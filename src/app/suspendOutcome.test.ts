import { describe, expect, it } from "vitest";
import { suspendRefusalText, type SuspendOutcome } from "./suspendOutcome";

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
