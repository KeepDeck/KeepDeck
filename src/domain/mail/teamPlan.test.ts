import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../deck";
import { createWorkspaceInstance } from "../workspaceInstance";
import { planTeam, teamPlanIsEmpty, type TeamDraft } from "./teamPlan";

const pane = (id: string, team?: { name: string; role: string }): Pane =>
  ({ id, agentType: "claude", ...(team ? { team } : {}) }) as Pane;

const workspace = (panes: Pane[]): Workspace =>
  ({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  }) as Workspace;

const draft = (over: Partial<TeamDraft> = {}): TeamDraft => ({
  name: "api",
  members: [],
  recruits: [],
  ...over,
});

describe("planTeam", () => {
  it("settles members and trims what it stores", () => {
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    const result = planTeam(
      ws,
      draft({
        name: "  api  ",
        members: [
          { paneId: "pane-1", role: " lead " },
          { paneId: "pane-2", role: "impl-1" },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: "api",
        members: [
          { paneId: "pane-1", role: "lead" },
          { paneId: "pane-2", role: "impl-1" },
        ],
        released: [],
        recruits: [],
      },
    });
  });

  it("names who is being taken OUT of the team", () => {
    // A team is the set of panes holding its name, so anyone the draft
    // dropped has left. Saying so here is what stops the caller
    // re-deriving it — and re-derivation is how a member gets stranded on
    // a team nobody thinks they are on.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
      pane("pane-3", { name: "web", role: "lead" }),
    ]);
    const result = planTeam(ws, draft({ members: [{ paneId: "pane-1", role: "lead" }] }));
    expect(result.ok && result.value.released).toEqual(["pane-2"]);
    // A pane on ANOTHER team is not this team's business.
    expect(result.ok && result.value.released).not.toContain("pane-3");
  });

  it("counts a role an unspawned recruit will hold as taken", () => {
    // Checking only the live half is how a team ends up with two impl-1s
    // the moment the second one starts.
    const ws = workspace([pane("pane-1")]);
    const result = planTeam(
      ws,
      draft({
        members: [{ paneId: "pane-1", role: "impl-1" }],
        recruits: [{ agentType: "claude", role: "IMPL-1" }],
      }),
    );
    expect(result.ok).toBe(false);
    // Quoted as the person TYPED it, so they can find it in the form —
    // echoing a normalised spelling sends them looking for a row that does
    // not read that way anywhere on screen.
    if (!result.ok) expect(result.message).toContain("IMPL-1");
  });

  it("refuses a nameless team and a roleless member", () => {
    const ws = workspace([pane("pane-1")]);
    expect(planTeam(ws, draft({ name: "  " })).ok).toBe(false);
    expect(
      planTeam(ws, draft({ members: [{ paneId: "pane-1", role: " " }] })).ok,
    ).toBe(false);
    expect(
      planTeam(ws, draft({ recruits: [{ agentType: "claude", role: "" }] })).ok,
    ).toBe(false);
  });

  it("matches the team name however it was cased", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    const result = planTeam(ws, draft({ name: "API", members: [] }));
    expect(result.ok && result.value.released).toEqual(["pane-1"]);
  });

  it("knows a plan that asks for nothing", () => {
    const ws = workspace([pane("pane-1")]);
    const result = planTeam(ws, draft());
    expect(result.ok && teamPlanIsEmpty(result.value)).toBe(true);
    const withOne = planTeam(ws, draft({ members: [{ paneId: "pane-1", role: "lead" }] }));
    expect(withOne.ok && teamPlanIsEmpty(withOne.value)).toBe(false);
  });
});
