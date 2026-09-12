import { describe, expect, it, vi } from "vitest";
import type { AgentDialogResult } from "../domain/agents";
import {
  placementRefusalMessage,
  TEAM_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  type Workspace,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
  CreateTeamOutcome,
  CreateTeamRequest,
} from "./agentOrchestrator";
import { createAgentDoors } from "./agentDoors";

const workspace = (): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "KeepDeck",
  cwd: "/repo",
  worktreeBaseDir: "/base",
  panes: [{ id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } }],
  teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo" } }],
});

const fresh = (): AgentDialogResult => ({
  agentType: "claude",
  name: "",
  location: { kind: "main" },
  yolo: false,
});
const handle = { agent: "claude" as const, sessionId: "s-1", cwd: "/repo", title: "t" };

function setup(ws: Workspace = workspace()) {
  const createPane = vi.fn<(request: CreatePaneRequest) => CreatePaneOutcome>(() => ({
    kind: "created",
    teamId: "team-1",
  }));
  const createTeam = vi.fn<(request: CreateTeamRequest) => CreateTeamOutcome>(() => ({
    kind: "created",
    teamId: "team-2",
  }));
  const resumeSession = vi.fn(() => Promise.resolve());
  const forkSession = vi.fn(() => Promise.resolve());
  const openTeam = vi.fn();
  const doors = createAgentDoors({
    orchestrator: { createPane, createTeam, resumeSession, forkSession },
    deck: { workspaces: () => [ws], openTeam },
  });
  const ref = { id: ws.id, instance: ws.instance };
  const team = (result: Partial<AgentDialogResult> = {}) =>
    doors.confirm({
      workspace: ref,
      agentId: "pane-9",
      index: 2,
      target: { kind: "new-team", suggestedName: "Team 2" },
      result: { ...fresh(), ...result },
    });
  const member = (result: Partial<AgentDialogResult> = {}, cwd: string | null = "/repo") =>
    doors.confirm({
      workspace: ref,
      agentId: "pane-9",
      index: 2,
      target: { kind: "member", teamId: "team-1", teamName: "api", cwd },
      result: { ...fresh(), ...result },
    });
  return { doors, createPane, createTeam, resumeSession, forkSession, openTeam, team, member };
}

describe("agent doors — a new team", () => {
  it("makes the team under the name given, at the location asked, and enters it", async () => {
    const h = setup();
    const outcome = await h.team({
      teamName: "docs",
      location: { kind: "new", path: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2", baseBranch: "develop" },
    });
    expect(outcome).toEqual({ kind: "done" });
    expect(h.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "docs",
        placement: expect.objectContaining({
          kind: "provisioning",
          intent: expect.objectContaining({
            repo: "/repo",
            path: "/base/kd-KeepDeck-2",
            branch: "kd/KeepDeck/2",
            base: "develop",
          }),
        }),
      }),
    );
    expect(h.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("falls back to the suggested name when the dialog gave none", async () => {
    const h = setup();
    await h.team();
    expect(h.createTeam).toHaveBeenCalledWith(expect.objectContaining({ name: "Team 2" }));
  });

  it("says a refusal in the door's words — gone, held, taken — and enters nothing", async () => {
    const h = setup();
    h.createTeam.mockReturnValueOnce({ kind: "gone" });
    expect(await h.team({ teamName: "docs" })).toEqual({
      kind: "refused",
      door: "team",
      message: WORKSPACE_GONE_MESSAGE,
    });
    h.createTeam.mockReturnValueOnce({ kind: "held", why: "creating" });
    expect(await h.team({ teamName: "docs" })).toEqual({
      kind: "refused",
      door: "team",
      message: placementRefusalMessage("creating"),
    });
    h.createTeam.mockReturnValueOnce({ kind: "taken" });
    expect(await h.team({ teamName: " api " })).toMatchObject({
      kind: "refused",
      door: "team",
      message: expect.stringContaining("“api” already exists"),
    });
    expect(h.openTeam).not.toHaveBeenCalled();
  });

  it("asks instead of refusing when the directory is another team's, and re-issues the SAME create with the answer", async () => {
    const h = setup();
    h.createTeam.mockReturnValueOnce({
      kind: "shared",
      directory: "/repo",
      holder: { teamId: "team-1", teamName: "api" },
    });
    const asked = await h.team({ teamName: "docs" });
    expect(asked).toMatchObject({
      kind: "ask-shared",
      path: "/repo",
      holder: { teamId: "team-1", teamName: "api" },
    });
    expect(h.openTeam).not.toHaveBeenCalled();
    if (asked.kind !== "ask-shared") throw new Error("expected a question");

    h.createTeam.mockReturnValueOnce({ kind: "created", teamId: "team-2" });
    expect(asked.anyway()).toEqual({ kind: "done" });
    expect(h.createTeam).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "docs", shared: true }),
    );
    expect(h.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
  });

  it("answers the re-issued create's refusal like any other — the workspace can go while the question stands", async () => {
    const h = setup();
    h.createTeam.mockReturnValueOnce({
      kind: "shared",
      directory: "/repo",
      holder: { teamId: "team-1", teamName: "api" },
    });
    const asked = await h.team({ teamName: "docs" });
    if (asked.kind !== "ask-shared") throw new Error("expected a question");
    h.createTeam.mockReturnValueOnce({ kind: "gone" });
    expect(asked.anyway()).toEqual({
      kind: "refused",
      door: "team",
      message: WORKSPACE_GONE_MESSAGE,
    });
    expect(h.openTeam).not.toHaveBeenCalled();
  });

  it("refuses a workspace that is gone before the team door is even asked", async () => {
    const old = workspace();
    const h = setup({ ...workspace(), instance: createWorkspaceInstance() });
    const outcome = await h.doors.confirm({
      workspace: { id: old.id, instance: old.instance },
      agentId: "pane-9",
      index: 2,
      target: { kind: "new-team", suggestedName: "Team 2" },
      result: { ...fresh(), teamName: "docs" },
    });
    expect(outcome).toEqual({ kind: "refused", door: "team", message: WORKSPACE_GONE_MESSAGE });
    expect(h.createTeam).not.toHaveBeenCalled();
  });
});

describe("agent doors — a member", () => {
  it("lands a fresh member on the team by id, under the role picked, choosing no location", async () => {
    const h = setup();
    expect(await h.member({ role: "impl-1" })).toEqual({ kind: "done" });
    const request = h.createPane.mock.calls[0][0];
    expect(request).toMatchObject({ team: "team-1", role: "impl-1", pane: { id: "pane-9" } });
    expect("placement" in request).toBe(false);
    expect("teamName" in request).toBe(false);
    expect(h.createTeam).not.toHaveBeenCalled();
    // Joining a team is not entering it: the stage stays where it was.
    expect(h.openTeam).not.toHaveBeenCalled();
  });

  it("says the landing's refusal in the one spelling every door uses", async () => {
    const h = setup();
    h.createPane.mockReturnValueOnce({ kind: "full" });
    expect(await h.member()).toEqual({ kind: "refused", door: "member", message: TEAM_FULL_MESSAGE });
    h.createPane.mockReturnValueOnce({ kind: "role", why: "taken", role: "lead" });
    expect(await h.member({ role: "lead" })).toMatchObject({
      kind: "refused",
      door: "member",
      message: expect.stringContaining('role "lead" is taken'),
    });
    h.createPane.mockReturnValueOnce({ kind: "gone" });
    expect(await h.member()).toEqual({ kind: "refused", door: "member", message: WORKSPACE_GONE_MESSAGE });
    h.createPane.mockReturnValueOnce({ kind: "held", why: "ending" });
    expect(await h.member()).toEqual({
      kind: "refused",
      door: "member",
      message: placementRefusalMessage("ending"),
    });
  });

  it("resumes a picked session in place, with the name, mode and role chosen", async () => {
    const h = setup();
    const outcome = await h.member({
      name: " Lead ",
      yolo: true,
      role: "impl-1",
      session: { mode: "resume", handle },
    });
    expect(outcome).toEqual({ kind: "done" });
    expect(h.resumeSession).toHaveBeenCalledWith("ws-1", handle, {
      name: "Lead",
      yolo: true,
      role: "impl-1",
    });
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("forks a picked session INTO the team's directory, and refuses while that directory is still being created", async () => {
    const h = setup();
    expect(await h.member({ session: { mode: "fork", handle } })).toEqual({ kind: "done" });
    expect(h.forkSession).toHaveBeenCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/repo" },
      { name: undefined, yolo: false },
    );

    expect(await h.member({ session: { mode: "fork", handle } }, null)).toEqual({
      kind: "refused",
      door: "fork",
      message: "the team's directory is not there yet",
    });
    expect(h.forkSession).toHaveBeenCalledTimes(1);
  });

  it("reports a continuation that failed, by the door it came through", async () => {
    const h = setup();
    h.resumeSession.mockRejectedValueOnce(new Error("The session is already running"));
    expect(await h.member({ session: { mode: "resume", handle } })).toEqual({
      kind: "refused",
      door: "resume",
      message: "The session is already running",
    });
    h.forkSession.mockRejectedValueOnce(new Error("no clone"));
    expect(await h.member({ session: { mode: "fork", handle } })).toEqual({
      kind: "refused",
      door: "fork",
      message: "no clone",
    });
  });

  it("refuses a workspace that is gone — or replaced under the same id — without touching the orchestrator", async () => {
    const old = workspace();
    const replacement = { ...workspace(), instance: createWorkspaceInstance() };
    const h = setup(replacement);
    const outcome = await h.doors.confirm({
      workspace: { id: old.id, instance: old.instance },
      agentId: "pane-9",
      index: 2,
      target: { kind: "member", teamId: "team-1", teamName: "api", cwd: "/repo" },
      result: fresh(),
    });
    expect(outcome).toEqual({ kind: "refused", door: "member", message: WORKSPACE_GONE_MESSAGE });
    expect(h.createPane).not.toHaveBeenCalled();
    expect(h.createTeam).not.toHaveBeenCalled();
  });
});
