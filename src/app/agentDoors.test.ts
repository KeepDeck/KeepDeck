import { describe, expect, it, vi } from "vitest";
import type { AgentDialogResult } from "../domain/agents";
import { NO_AGENT_MESSAGE, TEAM_FULL_MESSAGE, WORKSPACE_GONE_MESSAGE, type Workspace } from "../domain/deck";
import type { IntentOutcome, OwnerRefusal } from "../domain/lifecycle";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { intentOutcomeText, ownerRefusalText } from "../presentation/lifecycleWords";
import type { CreatePaneRequest, CreateTeamRequest } from "./agentOrchestrator";
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

const accepted = (team: string | null = null): IntentOutcome => ({
  kind: "accepted",
  op: 1,
  minted: { workspace: null, team, panes: team ? [] : ["pane-9"] },
});
const refusedWith = (why: OwnerRefusal): IntentOutcome => ({ kind: "refused", refusal: { kind: "rejected", why } });

function setup(ws: Workspace = workspace(), teamsAt: Record<string, string[]> = {}) {
  const createPane = vi.fn(async (_request: CreatePaneRequest) => accepted());
  const createTeam = vi.fn(async (_request: CreateTeamRequest) => accepted("team-2"));
  const resumeSession = vi.fn(async () => accepted());
  const forkSession = vi.fn(async () => accepted());
  const teamsIn = vi.fn(async (path: string) => teamsAt[path] ?? []);
  const openTeam = vi.fn();
  const doors = createAgentDoors({
    orchestrator: { createPane, createTeam, resumeSession, forkSession },
    deck: { workspaces: () => [ws], openTeam },
    teamsIn,
  });
  const ref = { id: ws.id, instance: ws.instance };
  const team = (result: Partial<AgentDialogResult> = {}) =>
    doors.confirm({ workspace: ref, target: { kind: "new-team", suggestedName: "Team 2" }, result: { ...fresh(), ...result } });
  const member = (result: Partial<AgentDialogResult> = {}, cwd: string | null = "/repo") =>
    doors.confirm({
      workspace: ref,
      target: { kind: "member", teamId: "team-1", teamName: "api", cwd },
      result: { ...fresh(), ...result },
    });
  return { doors, ref, createPane, createTeam, resumeSession, forkSession, teamsIn, openTeam, team, member };
}

describe("agent doors — a new team", () => {
  it("asks for the team under the name given, at the site asked, and enters the team the machine made", async () => {
    const h = setup();
    const outcome = await h.team({
      teamName: "docs",
      location: { kind: "new", path: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2", baseBranch: "develop" },
    });
    expect(outcome).toEqual({ kind: "done" });
    expect(h.createTeam).toHaveBeenCalledWith({
      workspace: h.ref,
      name: "docs",
      site: { kind: "new", place: { path: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2" }, base: "develop" },
    });
    // A new worktree's place is the machine's to refuse: nothing asks who
    // works there.
    expect(h.teamsIn).not.toHaveBeenCalled();
    expect(h.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("falls back to the suggested name when the dialog gave none", async () => {
    const h = setup(workspace(), {});
    await h.team({ location: { kind: "existing", path: "/elsewhere", branch: "" } });
    expect(h.createTeam).toHaveBeenCalledWith(expect.objectContaining({ name: "Team 2" }));
  });

  it("says a refusal in the door's words — the machine's, or a name a team here holds — and enters nothing", async () => {
    const h = setup();
    const held: IntentOutcome = { kind: "refused", refusal: { kind: "locationHeld" } };
    h.createTeam.mockResolvedValueOnce(held);
    expect(await h.team({ teamName: "docs", location: { kind: "new", path: "/base/x", branch: "kd/x" } })).toEqual({
      kind: "refused",
      door: "team",
      message: intentOutcomeText(held),
    });
    expect(await h.team({ teamName: " api " })).toMatchObject({
      kind: "refused",
      door: "team",
      message: expect.stringContaining("“api” already exists"),
    });
    expect(h.createTeam).toHaveBeenCalledTimes(1);
    expect(h.openTeam).not.toHaveBeenCalled();
  });

  it("asks instead of refusing when the directory is another team's, and issues the SAME create on the answer", async () => {
    const h = setup(workspace(), { "/repo": ["team-1"] });
    const asked = await h.team({ teamName: "docs" });
    expect(asked).toMatchObject({ kind: "ask-shared", path: "/repo", holder: { teamId: "team-1", teamName: "api" } });
    expect(h.createTeam).not.toHaveBeenCalled();
    if (asked.kind !== "ask-shared") throw new Error("expected a question");

    expect(await asked.anyway()).toEqual({ kind: "done" });
    expect(h.createTeam).toHaveBeenCalledExactlyOnceWith({ workspace: h.ref, name: "docs", site: { kind: "root" } });
    expect(h.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
  });

  it("answers the create's refusal like any other — the workspace can go while the question stands", async () => {
    const h = setup(workspace(), { "/repo": ["team-1"] });
    const asked = await h.team({ teamName: "docs" });
    if (asked.kind !== "ask-shared") throw new Error("expected a question");
    const gone: IntentOutcome = { kind: "refused", refusal: { kind: "notFound" } };
    h.createTeam.mockResolvedValueOnce(gone);
    expect(await asked.anyway()).toEqual({ kind: "refused", door: "team", message: intentOutcomeText(gone) });
    expect(h.openTeam).not.toHaveBeenCalled();
  });

  it("refuses a workspace that is gone before the team door is even asked", async () => {
    const old = workspace();
    const h = setup({ ...workspace(), instance: createWorkspaceInstance() });
    const outcome = await h.doors.confirm({
      workspace: { id: old.id, instance: old.instance },
      target: { kind: "new-team", suggestedName: "Team 2" },
      result: { ...fresh(), teamName: "docs" },
    });
    expect(outcome).toEqual({ kind: "refused", door: "team", message: WORKSPACE_GONE_MESSAGE });
    expect(h.createTeam).not.toHaveBeenCalled();
  });

  it("makes a team that names no agent — a team needs none", async () => {
    const h = setup();
    expect(await h.team({ agentType: null, teamName: "docs" })).toEqual({ kind: "done" });
    expect(h.createTeam).toHaveBeenCalledWith(expect.objectContaining({ site: { kind: "root" } }));
  });
});

describe("agent doors — a member", () => {
  it("seats a fresh member on the team by id, under the role picked, choosing no site", async () => {
    const h = setup();
    expect(await h.member({ role: "impl-1", name: " Docs ", yolo: true })).toEqual({ kind: "done" });
    // What the person typed, as typed: the member's draft at the
    // orchestrator's door is what trims it and writes it sparse.
    expect(h.createPane).toHaveBeenCalledExactlyOnceWith({
      workspace: h.ref,
      pane: { agentType: "claude", name: " Docs ", yolo: true },
      team: "team-1",
      role: "impl-1",
    });
    expect(h.createTeam).not.toHaveBeenCalled();
    // Joining a team is not entering it: the stage stays where it was.
    expect(h.openTeam).not.toHaveBeenCalled();
  });

  it("says the landing's refusal in the one spelling every door uses", async () => {
    const h = setup();
    h.createPane.mockResolvedValueOnce(refusedWith({ kind: "teamFull" }));
    expect(await h.member({ role: "impl-1" })).toEqual({ kind: "refused", door: "member", message: TEAM_FULL_MESSAGE });
  });

  it("resumes a picked session in place, with the name, mode and role chosen", async () => {
    const h = setup();
    const outcome = await h.member({ name: " Lead ", yolo: true, role: "impl-1", session: { mode: "resume", handle } });
    expect(outcome).toEqual({ kind: "done" });
    expect(h.resumeSession).toHaveBeenCalledWith("ws-1", handle, { team: "team-1", name: " Lead ", yolo: true, role: "impl-1" });
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("forks a picked session INTO the team's directory, and refuses while that directory is still being created", async () => {
    const h = setup();
    expect(await h.member({ role: "impl-1", session: { mode: "fork", handle } })).toEqual({ kind: "done" });
    expect(h.forkSession).toHaveBeenCalledWith("ws-1", handle, { kind: "dir", cwd: "/repo" }, {
      name: "",
      yolo: false,
      role: "impl-1",
      team: "team-1",
    });

    expect(await h.member({ role: "impl-1", session: { mode: "fork", handle } }, null)).toEqual({
      kind: "refused",
      door: "fork",
      message: "the team's directory is not there yet",
    });
    expect(h.forkSession).toHaveBeenCalledTimes(1);
  });

  it("reports a continuation the machine refused, by the door it came through", async () => {
    const h = setup();
    h.resumeSession.mockResolvedValueOnce(refusedWith({ kind: "sessionHeld" }));
    expect(await h.member({ role: "impl-1", session: { mode: "resume", handle } })).toEqual({
      kind: "refused",
      door: "resume",
      message: "That conversation is already open in another agent.",
    });
    h.forkSession.mockResolvedValueOnce(refusedWith({ kind: "failed" }));
    expect(await h.member({ role: "impl-1", session: { mode: "fork", handle } })).toEqual({
      kind: "refused",
      door: "fork",
      message: ownerRefusalText({ kind: "failed" }),
    });
  });

  it("refuses a member that names no agent, rather than assume one", async () => {
    const h = setup();
    expect(await h.member({ agentType: null })).toEqual({ kind: "refused", door: "member", message: NO_AGENT_MESSAGE });
    expect(h.createPane).not.toHaveBeenCalled();
  });

  it("refuses a workspace that is gone — or replaced under the same id — without touching the orchestrator", async () => {
    const old = workspace();
    const h = setup({ ...workspace(), instance: createWorkspaceInstance() });
    const outcome = await h.doors.confirm({
      workspace: { id: old.id, instance: old.instance },
      target: { kind: "member", teamId: "team-1", teamName: "api", cwd: "/repo" },
      result: fresh(),
    });
    expect(outcome).toEqual({ kind: "refused", door: "member", message: WORKSPACE_GONE_MESSAGE });
    expect(h.createPane).not.toHaveBeenCalled();
    expect(h.createTeam).not.toHaveBeenCalled();
  });
});

describe("agent doors — an empty team's sessions list", () => {
  const empty = (): Workspace => ({
    ...workspace(),
    panes: [],
    teams: [
      { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/wt" } },
      { id: "team-2", name: "web", location: { kind: "provisioning", intent: { repo: "/repo", path: "/base/w", index: 2 } } },
    ],
  });
  const continued = (h: ReturnType<typeof setup>, teamId: string, mode: "resume" | "fork") =>
    h.doors.continueSession({ workspace: h.ref, teamId, session: { mode, handle }, role: "lead" });

  it("resumes onto THIS team, by id, under the role picked", async () => {
    const h = setup(empty());
    expect(await continued(h, "team-1", "resume")).toEqual({ kind: "done" });
    expect(h.resumeSession).toHaveBeenCalledWith("ws-1", handle, { team: "team-1", role: "lead" });
  });

  it("forks INTO the team's directory, on the team by id", async () => {
    const h = setup(empty());
    expect(await continued(h, "team-1", "fork")).toEqual({ kind: "done" });
    expect(h.forkSession).toHaveBeenCalledWith("ws-1", handle, { kind: "dir", cwd: "/repo/wt" }, { team: "team-1", role: "lead" });
  });

  it("refuses a fork while the team's directory is being made, and a team that is gone", async () => {
    const h = setup(empty());
    expect(await continued(h, "team-2", "fork")).toEqual({
      kind: "refused",
      door: "fork",
      message: "the team's directory is not there yet",
    });
    expect(await continued(h, "team-9", "resume")).toEqual({
      kind: "refused",
      door: "resume",
      message: WORKSPACE_GONE_MESSAGE,
    });
    expect(h.forkSession).not.toHaveBeenCalled();
    expect(h.resumeSession).not.toHaveBeenCalled();
  });
});
