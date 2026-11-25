import { describe, expect, it } from "vitest";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createPaneIdentity } from "./paneIdentity";

const ws = (panes: Workspace["panes"]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
});

const agents = () => [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const identity = (workspaces: Workspace[]) => createPaneIdentity({ workspaces: () => workspaces, agents });

describe("naming the pane an admitted caller speaks for", () => {
  it("names it the way the deck does, at the moment it acted", () => {
    // The label is taken now rather than remembered, so a journal entry stays
    // readable after the pane is renamed or closed.
    const deck = [
      ws([
        { id: "p1", agentType: "claude" },
        { id: "p2", agentType: "codex" },
      ]),
    ];

    expect(identity(deck)({ pane: "p2" })).toEqual({
      id: "p2",
      workspaceId: "ws-1",
      label: "Codex 2",
    });
  });

  it("prefers the pane's own name over the positional label", () => {
    const deck = [ws([{ id: "p1", agentType: "claude", name: "reviewer" }])];
    expect(identity(deck)({ pane: "p1" })?.label).toBe("reviewer");
  });

  it("falls back to the raw agent id while the catalog is empty", () => {
    const deck = [ws([{ id: "p1", agentType: "kimi" }])];
    expect(identity(deck)({ pane: "p1" })?.label).toBe("kimi 1");
  });

  it("names nobody for a pane the deck no longer holds", () => {
    // The door admitted the caller, and its pane left while the line crossed.
    expect(identity([ws([{ id: "p1", agentType: "claude" }])])({ pane: "p9" })).toBeNull();
    expect(identity([])({ pane: "p1" })).toBeNull();
  });
});
