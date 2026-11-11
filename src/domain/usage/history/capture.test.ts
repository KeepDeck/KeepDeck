import { describe, expect, it } from "vitest";
import type { Workspace } from "../../deck";
import { createWorkspaceInstance } from "../../workspaceInstance";
import { usagePlace } from "./capture";

const ws: Workspace = {
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Deck",
  cwd: "/repo",
  worktreeBaseDir: null,
  teams: [
    { id: "team-1", name: "x", location: { kind: "attached", cwd: "/repo/wt", branch: "kd/x" } },
    { id: "team-2", name: "y", location: { kind: "attached", cwd: "/repo/wt2" } },
  ],
  panes: [
    { id: "p1", agentType: "claude", name: "Named", autoTitle: "ignored", team: { teamId: "team-1", role: "lead" } },
    { id: "p2", agentType: "codex", autoTitle: "vitest --watch", team: { teamId: "team-2", role: "lead" } },
    { id: "p3", agentType: "kimi" },
  ],
};

const pane = (id: string) => {
  const found = ws.panes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no pane ${id}`);
  return found;
};

describe("usagePlace", () => {
  it("names the pane by the user's name, else its own title, else its place in the workspace", () => {
    expect(usagePlace(ws, pane("p1")).paneName).toBe("Named");
    expect(usagePlace(ws, pane("p2")).paneName).toBe("vitest --watch");
    expect(usagePlace(ws, pane("p3")).paneName).toBe("Agent 3");
  });

  it("carries the workspace, and the worktree the pane works in with its branch when it has one", () => {
    expect(usagePlace(ws, pane("p1"))).toEqual({
      workspaceId: "ws-1",
      workspaceName: "Deck",
      workspaceCwd: "/repo",
      paneId: "p1",
      paneName: "Named",
      worktree: { path: "/repo/wt", repo: "/repo", branch: "kd/x" },
      team: { id: "team-1", name: "x", role: "lead" },
    });
    expect(usagePlace(ws, pane("p2")).worktree).toEqual({ path: "/repo/wt2", repo: "/repo" });
    // A pane in the workspace's own directory works in no worktree.
    expect(usagePlace(ws, pane("p3"))).not.toHaveProperty("worktree");
  });

  it("remembers the team by its name at the time and the pane's role, and no team for a pane on none", () => {
    expect(usagePlace(ws, pane("p2")).team).toEqual({ id: "team-2", name: "y", role: "lead" });
    expect(usagePlace(ws, pane("p3"))).not.toHaveProperty("team");
    // A membership naming a team the workspace no longer has is no team.
    const orphan = { ...pane("p3"), team: { teamId: "gone", role: "impl-1" } };
    expect(usagePlace(ws, orphan)).not.toHaveProperty("team");
  });
});
