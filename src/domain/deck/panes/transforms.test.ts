import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Workspace } from "../workspaces";
import { resetPaneSession, type Pane } from ".";

/**
 * The session reset, pinned directly. It used to drop the pane's directory
 * too; the directory is its team's now, and relocating a pane is the app
 * layer's, so all that is left to drop here is the session.
 */

const ws = (panes: Pane[]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws-1",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
});

describe("resetPaneSession", () => {
  it("drops the session, keeping everything else — the membership included", () => {
    const pane: Pane = {
      id: "pane-1",
      agentType: "claude",
      name: "kept",
      team: { teamId: "team-1", role: "lead" },
      session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" },
      idle: { reason: "waking", origin: "restore" },
    };
    const next = resetPaneSession([ws([pane])], "ws-1", "pane-1");
    expect(next[0].panes[0]).toEqual({
      id: "pane-1",
      agentType: "claude",
      name: "kept",
      team: { teamId: "team-1", role: "lead" },
      idle: { reason: "waking", origin: "restore" },
    });
  });

  it("returns the SAME array when there is no session to drop", () => {
    const bare: Pane = { id: "pane-1", agentType: "claude" };
    const workspaces = [ws([bare])];
    expect(resetPaneSession(workspaces, "ws-1", "pane-1")).toBe(workspaces);
  });

  it("returns the SAME array for an unknown pane or workspace", () => {
    const workspaces = [
      ws([{ id: "pane-1", session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" } }]),
    ];
    expect(resetPaneSession(workspaces, "ws-1", "pane-9")).toBe(workspaces);
    expect(resetPaneSession(workspaces, "ws-9", "pane-1")).toBe(workspaces);
  });

  it("keeps a remote endpoint and drops only the session", () => {
    const pane: Pane = {
      id: "pane-1",
      location: { kind: "remote", endpoint: "wss://vps" },
      session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" },
    };
    const next = resetPaneSession([ws([pane])], "ws-1", "pane-1");
    expect(next[0].panes[0]).toEqual({
      id: "pane-1",
      location: { kind: "remote", endpoint: "wss://vps" },
    });
  });

  it("touches only the named pane", () => {
    const other: Pane = { id: "pane-2", session: { id: "s-2", boundAt: "t" } };
    const target: Pane = { id: "pane-1", session: { id: "s-1", boundAt: "t" } };
    const next = resetPaneSession([ws([target, other])], "ws-1", "pane-1");
    expect(next[0].panes[1]).toBe(other);
  });
});
