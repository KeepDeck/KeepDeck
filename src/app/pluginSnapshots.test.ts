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
  panes: [
    { id: "p1", agentType: "claude", cwd: "/repo/wt", branch: "kd/x" },
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
        { id: "p1", name: "p1", cwd: "/repo/wt", branch: "kd/x", agentType: "claude" },
        { id: "p2", name: "vitest --watch", agentType: "unknown" },
        { id: "p3", name: "Named", agentType: "unknown" },
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
