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

/** A connection presenting a secret from inside `host`'s terminal. */
const from = (host: string) => ({ client: "secret", host });

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

    expect(identity(deck, () => "p2")(from("p2"))).toEqual({
      id: "p2",
      workspaceId: "ws-1",
      label: "Codex 2",
    });
  });

  it("prefers the pane's own name over the positional label", () => {
    const deck = [ws([{ id: "p1", agentType: "claude", name: "reviewer" }])];
    expect(identity(deck, () => "p1")(from("p1"))?.label).toBe("reviewer");
  });

  it("falls back to the raw agent id while the catalog is empty", () => {
    const deck = [ws([{ id: "p1", agentType: "kimi" }])];
    expect(identity(deck, () => "p1")(from("p1"))?.label).toBe("kimi 1");
  });

  it("answers ANONYMOUS for a secret that no longer resolves", () => {
    // A hand-wired server, or a lingering child of a pane that is gone. This
    // is the behaviour that existed before panes could be named at all, and it
    // is the right floor: naming the wrong pane is worse than naming none.
    const deck = [ws([{ id: "p1", agentType: "claude" }])];

    expect(identity(deck, () => null)({ client: "stranger", host: "p1" })).toBeNull();
    // The token resolves, but its pane has since been closed.
    expect(identity(deck, () => "p9")(from("p9"))).toBeNull();
    expect(identity([], () => "p1")(from("p1"))).toBeNull();
  });

  it("answers ANONYMOUS for a secret presented from outside its pane's terminal", () => {
    // A daemon worker that inherited the pane's MCP config: the secret is
    // the pane's, the process is not (task-424). And a process of ANOTHER
    // pane holding this one's secret speaks for neither.
    const deck = [ws([{ id: "p1", agentType: "claude" }, { id: "p2", agentType: "codex" }])];
    expect(identity(deck, () => "p1")({ client: "secret", host: null })).toBeNull();
    expect(identity(deck, () => "p1")({ client: "secret", host: "p2" })).toBeNull();
  });

  it("answers ANONYMOUS for a connection that presented no secret, wherever it runs", () => {
    const deck = [ws([{ id: "p1", agentType: "claude" }])];
    const paneOf = () => {
      throw new Error("nothing to resolve");
    };
    expect(identity(deck, paneOf)({ client: null, host: "p1" })).toBeNull();
  });
});
