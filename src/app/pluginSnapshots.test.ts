import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { toWorkspaceSnapshot } from "./pluginSnapshots";

const ws: Workspace = {
  id: "w1",
  instance: createWorkspaceInstance(),
  name: "Deck",
  cwd: "/repo",
  worktreeBaseDir: null,
  teams: [
    { id: "team-1", name: "x", location: { kind: "attached", cwd: "/repo/wt", branch: "kd/x" } },
    // Nobody on it: still a team, still a directory — a plugin sees the fact.
    { id: "team-2", name: "empty", location: { kind: "attached", cwd: "/repo/wt2", branch: "kd/y" } },
    // Being created: no directory yet, the branch it is heading for.
    {
      id: "team-3",
      name: "making",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/repo/wt3", branch: "kd/z", index: 3 } },
    },
  ],
  panes: [
    { id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
    { id: "p2", autoTitle: "vitest --watch" },
    { id: "p3", name: "Named", autoTitle: "ignored" },
  ],
};

describe("toWorkspaceSnapshot", () => {
  it("projects identity and location, drops runtime-only concerns", () => {
    expect(toWorkspaceSnapshot(ws)).toEqual({
      id: "w1",
      instance: ws.instance,
      name: "Deck",
      cwd: "/repo",
      panes: [
        { id: "p1", name: "p1", cwd: "/repo/wt", branch: "kd/x", agentType: "claude", team: "team-1" },
        { id: "p2", name: "vitest --watch", agentType: "unknown" },
        { id: "p3", name: "Named", agentType: "unknown" },
      ],
      teams: [
        { id: "team-1", name: "x", cwd: "/repo/wt", branch: "kd/x" },
        { id: "team-2", name: "empty", cwd: "/repo/wt2", branch: "kd/y" },
        { id: "team-3", name: "making", branch: "kd/z" },
      ],
    });
  });

  it("pane name precedence is manual name, then auto title, then id", () => {
    const [p1, p2, p3] = toWorkspaceSnapshot(ws).panes;
    expect(p1.name).toBe("p1");
    expect(p2.name).toBe("vitest --watch");
    expect(p3.name).toBe("Named");
  });
});
