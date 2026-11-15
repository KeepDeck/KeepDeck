import { describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../domain/agents";
import type { ResumeRequest, Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { askForPaneBack } from "./resumeOutcome";

const AGENTS: AgentInfo[] = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    features: [],
    installed: true,
    path: "/c",
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
