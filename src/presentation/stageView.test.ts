import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { NO_TEAMS_WORD, TEAM_SESSIONS_WORDS, stageContent, teamSessionsHint } from "./stageView";

const member = (id: string, teamId: string, role: string): Pane => ({ id, agentType: "claude", team: { teamId, role } });

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  teams: [
    { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/wt" } },
    { id: "team-2", name: "web", location: { kind: "provisioning", intent: { repo: "/repo", path: "/base/w", index: 2 } } },
  ],
  ...over,
});

describe("stageContent — what goes over the grid", () => {
  it("says there is no team when the workspace has none", () => {
    expect(stageContent(ws({ teams: [] }), undefined, 0)).toEqual({ kind: "no-teams", word: NO_TEAMS_WORD });
  });

  it("shows the cards while no team is open, and the grid while somebody is on it", () => {
    expect(stageContent(ws(), undefined, 0)).toEqual({ kind: "cards" });
    const led = ws({ panes: [member("p1", "team-1", "lead")] });
    expect(stageContent(led, { teamOpen: "team-1" }, 1)).toEqual({ kind: "grid" });
  });

  it("lists the sessions an open team with nobody on it can continue — in its directory", () => {
    expect(stageContent(ws(), { teamOpen: "team-1" }, 0)).toEqual({
      kind: "team-sessions",
      teamId: "team-1",
      cwd: "/repo/wt",
    });
  });

  it("keeps the word for a team whose directory is being made, and for one whose members are all hidden", () => {
    expect(stageContent(ws(), { teamOpen: "team-2" }, 0)).toMatchObject({
      kind: "word",
      word: { title: "No agents on this team" },
    });
    const hidden = ws({ panes: [member("p1", "team-1", "lead")] });
    expect(stageContent(hidden, { teamOpen: "team-1", minimized: ["p1"] }, 0)).toMatchObject({
      kind: "word",
      word: { title: "Every agent on this team is minimized" },
    });
  });
});

describe("teamSessionsHint — the line under the empty team's role picker", () => {
  it("gives the address a pick takes", () => {
    expect(teamSessionsHint("lead", true)).toEqual({ kind: "address", address: "lead" });
  });

  it("says nothing before a pick — the header stays one line — and the error once Resume or Fork was pressed without one", () => {
    expect(teamSessionsHint(null, false)).toBeNull();
    expect(teamSessionsHint(null, true)).toEqual({ kind: "error", text: TEAM_SESSIONS_WORDS.pickFirst });
  });
});
