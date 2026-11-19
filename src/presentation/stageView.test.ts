import { describe, expect, it, vi } from "vitest";
import type { Pane, TeamActFacts, Workspace } from "../domain/deck";
import { teamActsIn } from "../domain/deck/reducer.testSupport";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { teamResumeLabel } from "./resumeWords";
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

/** The orchestrator's answer for `w`'s teams, as the stage asks it. */
const actsOf = (w: Workspace, facts: Partial<TeamActFacts> = {}) => (teamId: string) =>
  teamActsIn([w], facts)(w.id, teamId);

describe("stageContent — what goes over the grid", () => {
  it("says there is no team when the workspace has none", () => {
    expect(stageContent(ws({ teams: [] }), undefined, 0, actsOf(ws({ teams: [] })))).toEqual({ kind: "no-teams", word: NO_TEAMS_WORD });
    // A pane outside every team (a legacy file) has no card to be reached
    // from; the stage says there is no team rather than showing nothing.
    expect(
      stageContent(ws({ teams: [], panes: [{ id: "loose", agentType: "claude" }] }), undefined, 0, () => null),
    ).toEqual({ kind: "no-teams", word: NO_TEAMS_WORD });
  });

  it("shows the cards while no team is open, and the grid while somebody is on it", () => {
    expect(stageContent(ws(), undefined, 0, actsOf(ws()))).toEqual({ kind: "cards" });
    const led = ws({ panes: [member("p1", "team-1", "lead")] });
    expect(stageContent(led, { teamOpen: "team-1" }, 1, actsOf(led))).toEqual({ kind: "grid" });
  });

  it("lists the sessions an open team with nobody on it can continue — in its directory", () => {
    expect(stageContent(ws(), { teamOpen: "team-1" }, 0, actsOf(ws()))).toEqual({
      kind: "team-sessions",
      teamId: "team-1",
      cwd: "/repo/wt",
    });
  });

  it("keeps the word for a team whose directory is being made, and for one whose members are all hidden", () => {
    expect(stageContent(ws(), { teamOpen: "team-2" }, 0, actsOf(ws()))).toMatchObject({
      kind: "word",
      word: { title: "No agents on this team" },
    });
    const hidden = ws({ panes: [member("p1", "team-1", "lead")] });
    expect(stageContent(hidden, { teamOpen: "team-1", minimized: ["p1"] }, 0, actsOf(hidden))).toMatchObject({
      kind: "word",
      word: { title: "Every agent on this team is minimized" },
    });
  });
});

describe("stageContent — the empty grid's Resume", () => {
  const AT = "2026-11-19T09:00:00.000Z";
  const down = (id: string): Pane => ({ ...member(id, "team-1", id), idle: { reason: "suspended", at: AT } });
  const allDown = ws({ panes: [down("p1"), down("p2")] });
  const trayed = { teamOpen: "team-1", suspendedTray: ["p1", "p2"] };

  it("offers the open team's Resume over a grid its whole team left, counted in the menu's words", () => {
    expect(stageContent(allDown, trayed, 0, actsOf(allDown))).toEqual({
      kind: "word",
      word: { title: "Every agent on this team is suspended", sub: "Restore one below to inspect it" },
      resume: { teamId: "team-1", label: teamResumeLabel(2) },
    });
  });

  it("counts only whom it would take, when some of the hidden are merely minimized", () => {
    const mixed = ws({ panes: [down("p1"), member("p2", "team-1", "p2")] });
    const content = stageContent(mixed, { teamOpen: "team-1", suspendedTray: ["p1"], minimized: ["p2"] }, 0, actsOf(mixed));
    expect(content).toMatchObject({ kind: "word", resume: { teamId: "team-1", label: teamResumeLabel(1) } });
  });

  it("offers nothing when its Resume would take nobody — all running, folders gone, or the team still being made", () => {
    const hidden = ws({ panes: [member("p1", "team-1", "lead")] });
    expect(stageContent(hidden, { teamOpen: "team-1", minimized: ["p1"] }, 0, actsOf(hidden))).toMatchObject({
      resume: null,
    });
    expect(stageContent(allDown, trayed, 0, actsOf(allDown, { blocked: () => true }))).toMatchObject({ resume: null });
    expect(stageContent(ws(), { teamOpen: "team-2" }, 0, actsOf(ws()))).toMatchObject({ resume: null });
    // A team the orchestrator no longer holds has no act to offer.
    expect(stageContent(allDown, trayed, 0, () => null)).toMatchObject({ resume: null });
  });

  it("asks only about the team that is open", () => {
    const asked = vi.fn(actsOf(allDown));
    stageContent(allDown, trayed, 0, asked);
    expect(asked.mock.calls).toEqual([["team-1"]]);
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
