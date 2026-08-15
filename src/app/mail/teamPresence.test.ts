import { describe, expect, it } from "vitest";
import { createTeamPresence, type TeamStanding } from "./teamPresence";

function setup(
  standing: (paneId: string) => TeamStanding | null,
  teamed: () => string[] = () => [],
) {
  const said: { paneId: string; body: string }[] = [];
  const sessions = new Set<(paneId: string) => void>();
  const rebuilds = new Set<(paneId: string) => void>();
  const catalog = new Set<() => void>();
  const roster = new Set<() => void>();
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
    onCatalogChanged: (listener) => {
      catalog.add(listener);
      return () => catalog.delete(listener);
    },
    onRosterChanged: (listener) => {
      roster.add(listener);
      return () => roster.delete(listener);
    },
    teamedPanes: teamed,
  });
  return {
    presence,
    said,
    freshSession: (paneId: string) => sessions.forEach((l) => l(paneId)),
    compacted: (paneId: string) => rebuilds.forEach((l) => l(paneId)),
    catalogChanged: () => catalog.forEach((l) => l()),
    rosterChanged: () => roster.forEach((l) => l()),
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

  it("re-briefs every teamed pane when the catalog changes, and nobody else", () => {
    // A catalog edit rewrites the charters live briefings were built from,
    // and unlike the other two signals it names no pane — so the presence
    // walks the teamed ones itself. A pane whose standing has meanwhile
    // gone answers null and stays silent, like anywhere else.
    const h = setup(
      (paneId) => (paneId === "pane-3" ? null : ON_TEAM),
      () => ["pane-1", "pane-2", "pane-3"],
    );
    h.catalogChanged();
    expect(h.said.map((s) => s.paneId)).toEqual(["pane-1", "pane-2"]);
  });

  it("owes a sweep that found nobody, and pays it when the roster lands", () => {
    // At boot a cross-session catalog edit fires before the restored deck
    // has hydrated. Consumed against an empty roster, the change is lost
    // and every restored team keeps briefing from texts the disk no
    // longer holds.
    let teamed: string[] = [];
    const h = setup(() => ON_TEAM, () => teamed);
    h.catalogChanged();
    expect(h.said).toEqual([]);
    teamed = ["pane-1"];
    h.rosterChanged();
    expect(h.said).toHaveLength(1);
    // Paid once: the next roster movement is not another sweep.
    h.rosterChanged();
    expect(h.said).toHaveLength(1);
  });

  it("stops on dispose", () => {
    const h = setup(() => ON_TEAM, () => ["pane-1"]);
    h.presence.dispose();
    h.freshSession("pane-1");
    h.compacted("pane-1");
    h.catalogChanged();
    expect(h.said).toEqual([]);
  });
});
