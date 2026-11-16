import { describe, expect, it } from "vitest";
import type { Team, Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { archiveConfirmView, archiveRefusalText } from "./archiveView";

const AT = "2026-11-16T00:00:00.000Z";
const failed: Team = {
  id: "t-failed",
  name: "broken",
  location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/x", index: 1 }, error: "refused" },
};
const making: Team = {
  id: "t-making",
  name: "new",
  location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/y", index: 2 } },
};
const ws = (panes: Workspace["panes"], teams: Team[] = []): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
  teams,
});
const first = (view: { message: string }) => view.message.split("\n\n")[0];

describe("archiveConfirmView", () => {
  it("counts what the archive stops — every local agent, parked and never-started ones too — apart from those already suspended", () => {
    const view = archiveConfirmView(
      ws(
        [
          { id: "running", agentType: "claude" },
          { id: "parked", agentType: "claude", idle: { reason: "parked" } },
          { id: "making", agentType: "claude", team: { teamId: "t-making", role: "lead" } },
          { id: "mine", agentType: "claude", idle: { reason: "suspended", at: AT } },
          // A failed create has no agent behind its card: not counted.
          { id: "card", agentType: "claude", team: { teamId: "t-failed", role: "lead" } },
        ],
        [failed, making],
      ),
    );
    expect(view.title).toBe("Archive “Web”?");
    expect(first(view)).toMatch(/^3 agents stop; 1 already suspended stays so\./);
    expect(view.confirmLabel).toBe("Archive");
  });

  it("says what becomes of a remote agent: it keeps running on its server", () => {
    const view = archiveConfirmView(ws([{ id: "far", agentType: "codex", location: { kind: "remote", endpoint: "ws://vps" } }]));
    expect(first(view)).toMatch(/^1 remote agent keeps running on its server; only the connection here closes\./);
  });

  it("speaks of a workspace whose agents are all suspended, and of one with none", () => {
    expect(first(archiveConfirmView(ws([{ id: "mine", agentType: "claude", idle: { reason: "suspended", at: AT } }])))).toMatch(
      /^Its agents are already suspended\./,
    );
    expect(first(archiveConfirmView(ws([])))).toMatch(/^It has no agents\./);
  });

  it("promises what is true: nothing deleted, nobody woken by Restore, where to find it", () => {
    const { message } = archiveConfirmView(ws([{ id: "running", agentType: "claude" }]));
    expect(message).toContain("Restore brings the workspace back with its agents still stopped");
    expect(message).toContain("resumes where it stopped when you resume it, if its agent can");
    expect(message).toContain("nothing of the workspace is deleted");
    expect(message).toContain("Find it under Archived");
  });
});

describe("archiveRefusalText", () => {
  it("speaks only of a refusal", () => {
    expect(archiveRefusalText("closing", "Web")).toBe("“Web” is being closed, so it cannot be archived.");
    expect(archiveRefusalText("gone", "Web")).toBe("“Web” is no longer open.");
    expect(archiveRefusalText("archived", "Web")).toBeNull();
    expect(archiveRefusalText("already", "Web")).toBeNull();
  });
});
