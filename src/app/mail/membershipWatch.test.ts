import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createMembershipWatch } from "./membershipWatch";

const on = (id: string, teamId: string, role: string): Pane => ({
  id,
  agentType: "claude",
  team: { teamId, role },
});

function setup(initial: Pane[], restoring = false) {
  let panes = initial;
  let isRestoring = restoring;
  const listeners = new Set<() => void>();
  const told: (readonly string[])[] = [];
  const watch = createMembershipWatch({
    workspaces: (): Workspace[] => [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes,
        teams: [
          { id: "team-1", name: "api" },
          { id: "team-2", name: "web" },
        ],
      },
    ],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restoring: () => isRestoring,
  });
  watch.onChanged((paneIds) => told.push(paneIds));
  return {
    watch,
    told,
    deckBecomes(next: Pane[]) {
      panes = next;
      for (const listener of [...listeners]) listener();
    },
    restored() {
      isRestoring = false;
    },
    listeners: () => listeners.size,
  };
}

describe("createMembershipWatch", () => {
  it("names the whole team when a member lands on it", () => {
    const h = setup([on("pane-1", "team-1", "lead")]);
    h.deckBecomes([on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]);
    expect(h.told).toEqual([["pane-1", "pane-2"]]);
  });

  it("names the rest when a member leaves", () => {
    const h = setup([on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]);
    h.deckBecomes([on("pane-1", "team-1", "lead")]);
    expect(h.told).toEqual([["pane-1"]]);
  });

  it("names both teams when a member moves between them", () => {
    const h = setup([on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]);
    h.deckBecomes([on("pane-1", "team-1", "lead"), on("pane-2", "team-2", "lead")]);
    expect(h.told).toEqual([["pane-1", "pane-2"]]);
  });

  it("says nothing for a deck change that moved no membership", () => {
    const h = setup([on("pane-1", "team-1", "lead")]);
    h.deckBecomes([{ ...on("pane-1", "team-1", "lead"), name: "renamed" }]);
    expect(h.told).toEqual([]);
  });

  it("says nothing when the last member leaves — nobody is left to tell", () => {
    const h = setup([on("pane-1", "team-1", "lead")]);
    h.deckBecomes([]);
    expect(h.told).toEqual([]);
  });

  it("takes a restore as the baseline, not as everyone joining", () => {
    // The deck comes back from disk with its teams already on it; the
    // panes resume sessions that were briefed when the teams formed.
    const h = setup([], true);
    h.deckBecomes([on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]);
    expect(h.told).toEqual([]);
    h.restored();
    // The first LIVE move after the restore is measured against what the
    // restore brought, not against the empty deck the watch was born with.
    h.deckBecomes([
      on("pane-1", "team-1", "lead"),
      on("pane-2", "team-1", "impl-1"),
      on("pane-3", "team-1", "impl-2"),
    ]);
    expect(h.told).toEqual([["pane-1", "pane-2", "pane-3"]]);
  });

  it("unsubscribes from the deck at dispose", () => {
    const h = setup([on("pane-1", "team-1", "lead")]);
    h.watch.dispose();
    expect(h.listeners()).toBe(0);
    h.deckBecomes([on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]);
    expect(h.told).toEqual([]);
  });
});
