// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Workspace } from "../domain/deck";
import { teamActsIn } from "../domain/deck/reducer.testSupport";
import type { PaneActivity } from "../domain/status";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { useTeamSuspendFlow, type TeamSuspendFlow } from "./useTeamSuspendFlow";

const member = (id: string, teamId: string, over: Partial<Pane> = {}): Pane => ({
  id,
  agentType: "claude",
  team: { teamId, role: id },
  ...over,
});

/** Team "api" of three — two running, one parked — beside team "web". */
const deckOf = (panes?: Pane[]): Workspace[] => [
  {
    id: "ws-1",
    instance: INSTANCE,
    name: "Web",
    cwd: "/repo",
    worktreeBaseDir: null,
    teams: [
      { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo" } },
      { id: "team-2", name: "web", location: { kind: "attached", cwd: "/repo" } },
    ],
    panes: panes ?? [
      member("a", "team-1"),
      member("b", "team-1"),
      member("c", "team-1", { idle: { reason: "parked" } }),
      member("w", "team-2"),
    ],
  },
];
const INSTANCE = createWorkspaceInstance();

describe("useTeamSuspendFlow", () => {
  let root: Root;
  let flow: TeamSuspendFlow;
  let deck: Workspace[];
  let activities: Map<string, PaneActivity>;
  /** Panes a suspend is still reaping — read by the decision at the call. */
  let reaping: Set<string>;
  const suspendTeam = vi.fn<(wsId: string, teamId: string, named: readonly string[]) => Promise<void>>();

  function Probe({ workspaces }: { workspaces: Workspace[] }) {
    flow = useTeamSuspendFlow({
      workspaces,
      activities,
      teamActs: teamActsIn(workspaces, { suspending: (paneId) => reaping.has(paneId) }),
      suspendTeam,
    });
    return null;
  }
  const render = () => act(() => root.render(createElement(Probe, { workspaces: deck })));

  beforeEach(() => {
    suspendTeam.mockReset().mockResolvedValue();
    deck = deckOf();
    activities = new Map();
    reaping = new Set();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    render();
  });
  afterEach(() => act(() => root.unmount()));

  it("asks first even with nobody mid-turn, then stops exactly the members it named", async () => {
    act(() => flow.request("ws-1", "team-1"));
    expect(flow.confirming).toMatchObject({ title: "Suspend “api”?", confirmLabel: "Suspend all 2", shown: ["a", "b"] });
    expect(suspendTeam).not.toHaveBeenCalled();

    await act(async () => flow.confirm());
    expect(suspendTeam).toHaveBeenCalledWith("ws-1", "team-1", ["a", "b"]);
    expect(flow.confirming).toBeNull();
  });

  it("names whose work is at risk from the live activity", () => {
    activities = new Map([["a", { state: "working", since: 1 }]]);
    render();
    act(() => flow.request("ws-1", "team-1"));
    expect(flow.confirming?.message).toContain("1 is in the middle of a turn — that work may be lost.");
  });

  it("hands the door exactly what it showed — not one that became stoppable after it last drew", async () => {
    act(() => flow.request("ws-1", "team-1"));
    expect(flow.confirming?.shown).toEqual(["a", "b"]);

    // Another suspend takes "b" down while the dialog stands: it drops out.
    reaping = new Set(["b"]);
    render();
    expect(flow.confirming?.shown).toEqual(["a"]);

    // That reap ends with no render in between; the person clicks what they
    // see — one agent — and one agent is what the door is handed.
    reaping = new Set();
    await act(async () => flow.confirm());
    expect(suspendTeam).toHaveBeenCalledWith("ws-1", "team-1", ["a"]);
  });

  it("cancel stops nobody", () => {
    act(() => flow.request("ws-1", "team-1"));
    act(() => flow.cancel());
    expect(flow.confirming).toBeNull();
    expect(suspendTeam).not.toHaveBeenCalled();
  });

  it("never stops a member that came up while it stood — the confirm never named it", async () => {
    act(() => flow.request("ws-1", "team-1"));
    deck = deckOf([member("a", "team-1"), member("b", "team-1"), member("c", "team-1"), member("w", "team-2")]);
    render();
    expect(flow.confirming?.shown).toEqual(["a", "b"]);

    await act(async () => flow.confirm());
    expect(suspendTeam).toHaveBeenCalledWith("ws-1", "team-1", ["a", "b"]);
  });

  it("drops from its count a member stopped elsewhere meanwhile, and goes away with nobody left", () => {
    act(() => flow.request("ws-1", "team-1"));
    const stopped = { idle: { reason: "suspended" as const, at: "2026-11-19T10:00:00.000Z" } };
    deck = deckOf([member("a", "team-1"), member("b", "team-1", stopped), member("w", "team-2")]);
    render();
    expect(flow.confirming).toMatchObject({ confirmLabel: "Suspend", shown: ["a"] });

    deck = deckOf([member("a", "team-1", stopped), member("w", "team-2")]);
    render();
    expect(flow.confirming).toBeNull();
    act(() => flow.confirm());
    expect(suspendTeam).not.toHaveBeenCalled();
  });

  it("ends — not hides — once nobody is left, so a named member coming back up raises nothing", () => {
    act(() => flow.request("ws-1", "team-1"));
    const stopped = { idle: { reason: "suspended" as const, at: "2026-11-19T10:00:00.000Z" } };
    deck = deckOf([member("a", "team-1", stopped), member("b", "team-1", stopped), member("w", "team-2")]);
    render();
    expect(flow.confirming).toBeNull();

    // A teammate's agent.resume brings "a" back: no Suspend was asked for.
    deck = deckOf([member("a", "team-1"), member("b", "team-1", stopped), member("w", "team-2")]);
    render();
    expect(flow.confirming).toBeNull();
    expect(suspendTeam).not.toHaveBeenCalled();
  });

  it("goes away when its team is disbanded, and does not come back for a team of that name", () => {
    act(() => flow.request("ws-1", "team-1"));
    deck = [{ ...deckOf()[0], teams: deckOf()[0].teams?.filter((team) => team.id !== "team-1") }];
    render();
    expect(flow.confirming).toBeNull();
  });

  it("opens nothing for a team with nobody to stop, or a workspace that is not there", () => {
    deck = deckOf([member("c", "team-1", { idle: { reason: "parked" } })]);
    render();
    act(() => flow.request("ws-1", "team-1"));
    expect(flow.confirming).toBeNull();
    act(() => flow.request("ws-9", "team-1"));
    expect(flow.confirming).toBeNull();
  });
});
