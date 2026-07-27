import { describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../domain/agents";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { ResumeRequest } from "./agentOrchestrator";
import { askForPaneBack, resumeRefusalText } from "./resumeOutcome";

const AGENTS: AgentInfo[] = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    supportsYolo: true,
    installed: true,
    path: "/c",
    usageCapabilities: [],
  },
];

const deck = (): Workspace[] => [
  {
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [{ id: "pane-1", agentType: "claude" }],
  },
];

describe("askForPaneBack", () => {
  it("answers null when the pane is coming back", () => {
    const resume = vi.fn<() => ResumeRequest>(() => "resuming");
    expect(askForPaneBack(resume, deck(), AGENTS, "ws-1", "pane-1")).toBeNull();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("names the pane from the deck as it stood BEFORE the request", () => {
    // The request can change the very pane the sentence is about — a resume
    // that lands moves it out of the state the label described. Reading after
    // would name whatever the deck became.
    const workspaces = deck();
    const resume = vi.fn<() => ResumeRequest>(() => {
      workspaces[0].panes = [];
      return "unavailable";
    });

    expect(askForPaneBack(resume, workspaces, AGENTS, "ws-1", "pane-1")).toBe(
      "No installed agent can start Claude 1.",
    );
  });

  it("falls back to a generic name for a pane that is already gone", () => {
    const resume = vi.fn<() => ResumeRequest>(() => "gone");
    expect(askForPaneBack(resume, [], AGENTS, "ws-1", "pane-1")).toBe(
      "That agent is no longer open.",
    );
  });
});

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
