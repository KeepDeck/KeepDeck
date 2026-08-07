import { describe, expect, it } from "vitest";
import { createTeamPresence, type TeamStanding } from "./teamPresence";

function setup(standing: (paneId: string) => TeamStanding | null) {
  const said: { paneId: string; body: string }[] = [];
  const sessions = new Set<(paneId: string) => void>();
  const rebuilds = new Set<(paneId: string) => void>();
  const presence = createTeamPresence({
    standingOf: standing,
    announce: (paneId, body) => said.push({ paneId, body }),
    onSessionBegan: (listener) => {
      sessions.add(listener);
      return () => sessions.delete(listener);
    },
    onContextRebuilt: (listener) => {
      rebuilds.add(listener);
      return () => rebuilds.delete(listener);
    },
  });
  return {
    presence,
    said,
    freshSession: (paneId: string) => sessions.forEach((l) => l(paneId)),
    compacted: (paneId: string) => rebuilds.forEach((l) => l(paneId)),
  };
}

const ON_TEAM: TeamStanding = {
  team: "api",
  role: "lead",
  everyRole: ["lead", "impl-1"],
};

describe("createTeamPresence", () => {
  it("says it again when the conversation starts over", () => {
    // A pane restored without its history, or a `/clear`: the agent is
    // still on the team and has no idea, which is worse than never having
    // been told — the deck now believes it knows.
    const h = setup(() => ON_TEAM);
    h.freshSession("pane-1");
    expect(h.said).toHaveLength(1);
    expect(h.said[0].paneId).toBe("pane-1");
    expect(h.said[0].body).toContain('as "lead"');
    expect(h.said[0].body).toContain("impl-1");
  });

  it("says it again when the context is compacted out from under it", () => {
    // The long-running case: nothing about the pane changed, but what the
    // agent can still see did.
    const h = setup(() => ON_TEAM);
    h.compacted("pane-1");
    expect(h.said).toHaveLength(1);
  });

  it("stays silent for a pane on no team", () => {
    // Which is every pane, for anyone not using the feature.
    const h = setup(() => null);
    h.freshSession("pane-1");
    h.compacted("pane-1");
    expect(h.said).toEqual([]);
  });

  it("reads the standing fresh each time, never a remembered one", () => {
    // Membership moves under this: a pane briefed as `lead` may be `impl-2`
    // by its next compaction, and re-stating the old role would be worse
    // than saying nothing.
    let role = "lead";
    const h = setup(() => ({ team: "api", role, everyRole: [role] }));
    h.compacted("pane-1");
    role = "impl-2";
    h.compacted("pane-1");
    expect(h.said.map((s) => s.body.includes('as "impl-2"'))).toEqual([false, true]);
  });

  it("stops on dispose", () => {
    const h = setup(() => ON_TEAM);
    h.presence.dispose();
    h.freshSession("pane-1");
    h.compacted("pane-1");
    expect(h.said).toEqual([]);
  });
});
