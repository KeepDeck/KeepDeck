import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Workspace } from "../workspaces";
import { resetPaneLocation, type Pane } from ".";

/**
 * The placement transitions, pinned directly.
 *
 * `resolvePaneProvisioning` and `setPaneProvisioningError` are pinned in
 * `workspaces.test.ts` (their historical home); `resetPaneLocation` was only
 * ever exercised through the reducer, which checks the drop and nothing else.
 */

const ws = (panes: Pane[]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws-1",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
});

describe("resetPaneLocation", () => {
  it("drops the worktree and the session together, keeping everything else", () => {
    const pane: Pane = {
      id: "pane-1",
      agentType: "claude",
      name: "kept",
      location: { kind: "attached", cwd: "/repo/wt", branch: "kd/ws/1" },
      session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" },
      idle: { reason: "waking", origin: "restore" },
    };
    const next = resetPaneLocation([ws([pane])], "ws-1", "pane-1");
    expect(next[0].panes[0]).toEqual({
      id: "pane-1",
      agentType: "claude",
      name: "kept",
      idle: { reason: "waking", origin: "restore" },
    });
  });

  it("drops a session alone — a directory-bound session cannot follow a pane elsewhere", () => {
    const pane: Pane = {
      id: "pane-1",
      session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" },
    };
    const next = resetPaneLocation([ws([pane])], "ws-1", "pane-1");
    expect(next[0].panes[0]).toEqual({ id: "pane-1" });
  });

  it("drops a recorded branch that has no directory beside it", () => {
    const pane: Pane = { id: "pane-1", location: { kind: "main", branch: "kd/ws/1" } };
    const next = resetPaneLocation([ws([pane])], "ws-1", "pane-1");
    expect(next[0].panes[0]).toEqual({ id: "pane-1" });
  });

  it("returns the SAME array when there is nothing to drop", () => {
    const bare: Pane = { id: "pane-1", agentType: "claude" };
    const workspaces = [ws([bare])];
    expect(resetPaneLocation(workspaces, "ws-1", "pane-1")).toBe(workspaces);
  });

  it("returns the SAME array for an unknown pane or workspace", () => {
    const workspaces = [ws([{ id: "pane-1", location: { kind: "attached", cwd: "/repo/wt" } }])];
    expect(resetPaneLocation(workspaces, "ws-1", "pane-9")).toBe(workspaces);
    expect(resetPaneLocation(workspaces, "ws-9", "pane-1")).toBe(workspaces);
  });

  it("leaves a provisioning card alone — a create in flight is not a location to reset", () => {
    const pane: Pane = {
      id: "pane-1",
      location: {
        kind: "provisioning",
        card: { repo: "/repo", path: "/repo/wt", index: 1 },
      },
    };
    const workspaces = [ws([pane])];
    expect(resetPaneLocation(workspaces, "ws-1", "pane-1")).toBe(workspaces);
  });

  it("keeps a remote endpoint and drops only the session", () => {
    const pane: Pane = {
      id: "pane-1",
      location: { kind: "remote", endpoint: "wss://vps" },
      session: { id: "s-1", boundAt: "2026-07-07T00:00:00Z" },
    };
    const next = resetPaneLocation([ws([pane])], "ws-1", "pane-1");
    expect(next[0].panes[0]).toEqual({
      id: "pane-1",
      location: { kind: "remote", endpoint: "wss://vps" },
    });
  });

  it("touches only the named pane", () => {
    const other: Pane = { id: "pane-2", location: { kind: "attached", cwd: "/repo/other" } };
    const target: Pane = { id: "pane-1", location: { kind: "attached", cwd: "/repo/wt" } };
    const next = resetPaneLocation([ws([target, other])], "ws-1", "pane-1");
    expect(next[0].panes[1]).toBe(other);
  });
});
