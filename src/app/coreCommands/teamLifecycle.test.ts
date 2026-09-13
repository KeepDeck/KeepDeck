// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it } from "vitest";
import type { Team, Workspace } from "../../domain/deck";

beforeEach(() => {
  resetCoreCommandTestState();
});

const FAILED: Team["location"] = {
  kind: "provisioning",
  intent: { repo: "/repo", path: "/wt/docs", branch: "kd/docs", index: 2 },
  error: "boom",
};
const CREATING: Team["location"] = {
  kind: "provisioning",
  intent: { repo: "/repo", path: "/wt/docs", branch: "kd/docs", index: 2 },
};

/** Two teams in the active workspace: api, ready on its own worktree with a
 * lead on it, and docs, wherever a case puts it. */
const teamed = (docs?: Team["location"]): Workspace =>
  workspace({
    teams: [
      { id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/api" } },
      { id: "team-2", name: "docs", ...(docs && { location: docs }) },
    ],
    panes: [{ id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } }],
  });

describe("team.enter", () => {
  it("puts the person inside the team it names — by name or id, in the active workspace when none is named", async () => {
    const { registry, activateTeam } = setup([teamed()]);
    const byName = await registry.execute("team.enter", { team: "API" }, HOST);
    expect(byName).toEqual({ ok: true, value: { workspaceId: "ws-1", teamId: "team-1" } });
    const byId = await registry.execute("team.enter", { team: "team-2", workspace: "web" }, HOST);
    expect(byId.ok).toBe(true);
    expect(activateTeam.mock.calls).toEqual([
      ["ws-1", "team-1"],
      ["ws-1", "team-2"],
    ]);
  });

  it("refuses a team that is not here, and enters nothing", async () => {
    const { registry, activateTeam } = setup([teamed()]);
    const result = await registry.execute("team.enter", { team: "nowhere" }, HOST);
    expect(result.ok).toBe(false);
    expect(activateTeam).not.toHaveBeenCalled();
  });
});

describe("team.rename", () => {
  it("renames the team through the deck, and answers the name it now has", async () => {
    const { registry, deck } = setup([teamed()]);
    const result = await registry.execute("team.rename", { team: "api", name: " platform " }, HOST);
    expect(result).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", teamId: "team-1", name: "platform" },
    });
    expect(deck.renameTeam).toHaveBeenCalledWith("ws-1", "team-1", "platform");
  });

  it("refuses a blank name, and a name another team here holds — in words, since the deck's rename is silent about both", async () => {
    const { registry, deck } = setup([teamed()]);
    const blank = await registry.execute("team.rename", { team: "api", name: "  " }, HOST);
    expect(blank.ok).toBe(false);
    // However cased: the name is compared the way every team name is.
    const taken = await registry.execute("team.rename", { team: "api", name: "DOCS" }, HOST);
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error.message).toContain("DOCS");
    expect(deck.renameTeam).not.toHaveBeenCalled();
  });
});

describe("team.retry", () => {
  it("re-issues a failed worktree create, and says where it is heading", async () => {
    const { registry, retryProvisioning } = setup([teamed(FAILED)]);
    const result = await registry.execute("team.retry", { team: "docs" }, HOST);
    expect(result).toEqual({
      ok: true,
      value: {
        workspaceId: "ws-1",
        teamId: "team-2",
        worktree: { path: "/wt/docs", branch: "kd/docs" },
      },
    });
    expect(retryProvisioning).toHaveBeenCalledWith("ws-1", "team-2");
  });

  it("refuses a team with nothing to retry — one still creating, or one already running", async () => {
    // The card shows Retry only when it applies; an agent sees no card, so
    // the two cases the card hides are refused with their reasons.
    const { registry, retryProvisioning } = setup([teamed(CREATING)]);
    const still = await registry.execute("team.retry", { team: "docs" }, HOST);
    expect(still.ok).toBe(false);
    if (!still.ok) expect(still.error.message).toContain("still being created");
    const running = await registry.execute("team.retry", { team: "api" }, HOST);
    expect(running.ok).toBe(false);
    if (!running.ok) expect(running.error.message).toContain("not waiting on a worktree create");
    expect(retryProvisioning).not.toHaveBeenCalled();
  });
});

describe("team.disband", () => {
  it("opens the confirm dialog rather than disbanding on its own — the card's door, worktree offer and all", async () => {
    const { registry, requestDisbandTeam } = setup([teamed()]);
    const result = await registry.execute("team.disband", { team: "api" }, HOST);
    expect(result).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", teamId: "team-1", name: "api", confirm: "dialog" },
    });
    expect(requestDisbandTeam).toHaveBeenCalledWith("ws-1", "team-1");
  });
});
