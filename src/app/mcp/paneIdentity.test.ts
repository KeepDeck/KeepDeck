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

const identity = (
  workspaces: Workspace[],
  paneOf: (client: string) => string | null,
) => createPaneIdentity({ workspaces: () => workspaces, paneOf, agents });

describe("naming the pane behind a connection", () => {
  it("names it the way the deck does, at the moment it acted", () => {
    // `pane-N` is positional and a slot a later pane inherits, so the label is
    // taken now rather than remembered — a journal entry has to stay readable.
    const deck = [
      ws([
        { id: "p1", agentType: "claude" },
        { id: "p2", agentType: "codex" },
      ]),
    ];

    expect(identity(deck, () => "p2")("secret")).toEqual({
      id: "p2",
      workspaceId: "ws-1",
      label: "Codex 2",
    });
  });

  it("prefers the pane's own name over the positional label", () => {
    const deck = [ws([{ id: "p1", agentType: "claude", name: "reviewer" }])];
    expect(identity(deck, () => "p1")("secret")?.label).toBe("reviewer");
  });

  it("falls back to the raw agent id while the catalog is empty", () => {
    const deck = [ws([{ id: "p1", agentType: "kimi" }])];
    expect(identity(deck, () => "p1")("secret")?.label).toBe("kimi 1");
  });

  it("answers ANONYMOUS for a secret that no longer resolves", () => {
    // A hand-wired server, or a lingering child of a pane that is gone. This
    // is the behaviour that existed before panes could be named at all, and it
    // is the right floor: naming the wrong pane is worse than naming none.
    const deck = [ws([{ id: "p1", agentType: "claude" }])];

    expect(identity(deck, () => null)("stranger")).toBeNull();
    // The token resolves, but its pane has since been closed.
    expect(identity(deck, () => "p9")("secret")).toBeNull();
    expect(identity([], () => "p1")("secret")).toBeNull();
  });
});
