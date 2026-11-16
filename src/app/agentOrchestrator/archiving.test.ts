// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Probe,
  agentRun,
  catalog,
  createWorkspaceInstance,
  deck,
  disarms,
  emptyJournal,
  ipc,
  peekPaneSpawnSpec,
  plans,
  pty,
  published,
  resetPaneSpawnSpecs,
  settle,
  settling,
} from "./testSupport";
import type { DeckState, Pane } from "./testSupport";
import type { Team, WorkspaceArchived } from "../../domain/deck";
import { present } from "@keepdeck/plugin-api/testing";

const AT = "2026-11-16T10:00:00.000Z";
const EARLIER = "2026-11-01T00:00:00.000Z";

/** ws-1 (on screen) holds the panes under test; ws-2 is somewhere to land. */
const deckOf = (panes: Pane[], over: { teams?: Team[]; archived?: WorkspaceArchived } = {}): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "web",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes,
      ...over,
    },
    {
      id: "ws-2",
      instance: createWorkspaceInstance(),
      name: "site",
      cwd: "/site",
      worktreeBaseDir: null,
      panes: [{ id: "elsewhere", agentType: "claude" }],
    },
  ],
  activeId: "ws-1",
  journal: emptyJournal,
  viewByWs: {},
});

const ws1 = () => present(deck.workspaces.find((ws) => ws.id === "ws-1"), "ws-1");
const ref = () => ({ id: ws1().id, instance: ws1().instance });
const idleOf = (paneId: string) => ws1().panes.find((pane) => pane.id === paneId)?.idle;

describe("archiving a workspace", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    settling.clear();
    disarms.asked = [];
    disarms.ok = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("stops every local agent durably, ends the processes, takes the plantings back, and settles", async () => {
    act(() =>
      deck.hydrate(
        deckOf([
          { id: "running", agentType: "claude" },
          { id: "mine", agentType: "claude", idle: { reason: "suspended", at: EARLIER } },
          { id: "remote", agentType: "codex", location: { kind: "remote", endpoint: "ws://vps:4500" } },
        ]),
      ),
    );
    await settle();
    expect(pty.live.has("running")).toBe(true);
    expect(pty.live.has("remote")).toBe(true);

    let outcome: unknown;
    await act(async () => {
      outcome = await agentRun.archive(ref());
    });

    expect(outcome).toBe("archived");
    expect(ws1().archived).toMatchObject({ phase: "archived" });
    expect(ws1().archived?.warnings).toBeUndefined();
    // Down for good — the person's own suspend keeps its date; a remote
    // agent is the server's, only its client is ended.
    expect(idleOf("running")).toMatchObject({ reason: "suspended" });
    expect(idleOf("mine")).toEqual({ reason: "suspended", at: EARLIER });
    expect(idleOf("remote")).toBeUndefined();
    expect(pty.closed.sort()).toEqual(["remote", "running"]);
    expect(disarms.asked).toEqual(["ws-1"]);
    // The person lands on what is left in the strip.
    expect(deck.activeId).toBe("ws-2");
  });

  it("refuses an archive of what is gone or already put away", async () => {
    act(() => deck.hydrate(deckOf([{ id: "p", agentType: "claude" }])));
    await settle();
    const held = ref();
    await act(async () => {
      expect(await agentRun.archive(held)).toBe("archived");
      expect(await agentRun.archive(held)).toBe("already");
      expect(await agentRun.archive({ id: "ws-9", instance: createWorkspaceInstance() })).toBe("gone");
    });
  });

  it("records what it could not finish: an agent that would not stop, plantings not taken back", async () => {
    act(() => deck.hydrate(deckOf([{ id: "stuck", agentType: "claude" }])));
    await settle();
    pty.hold = Promise.reject(new Error("kill refused"));
    pty.hold.catch(() => {});
    disarms.ok = false;

    await act(async () => {
      await agentRun.archive(ref());
    });

    expect(ws1().archived).toMatchObject({ phase: "archived", warnings: { reaps: ["stuck"], disarm: true } });
    // Its marker stands whatever its process did: nothing restarts it.
    expect(idleOf("stuck")).toMatchObject({ reason: "suspended" });
  });

  it("waits out a create still changing a team, then stops what landed", async () => {
    const team: Team = {
      id: "team-new",
      name: "api",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/api", index: 1 } },
    };
    act(() => deck.hydrate(deckOf([{ id: "member", agentType: "claude", team: { teamId: "team-new", role: "lead" } }], { teams: [team] })));
    await settle();
    let land!: () => void;
    settling.set(
      "team-new",
      new Promise((resolve) => {
        land = () => {
          deck.resolveTeamProvisioning("ws-1", "team-new", { cwd: "/wt/api", branch: "kd/api" });
          resolve("resolved");
        };
      }),
    );

    let archiving!: Promise<unknown>;
    act(() => {
      archiving = agentRun.archive(ref());
    });
    await settle();
    // Put away at once; the pass waits for the create before it settles.
    expect(ws1().archived?.phase).toBe("archiving");
    expect(disarms.asked).toEqual([]);

    await act(async () => {
      land();
      await archiving;
    });
    expect(ws1().archived?.phase).toBe("archived");
    // The pane that landed is stopped like the rest, and never ran.
    expect(idleOf("member")).toEqual({ reason: "suspended", at: present(ws1().archived, "marker").at });
    expect(pty.acquired.map((a) => a.paneId)).not.toContain("member");
  });

  it("a restore while the pass still waits stops the pass where it is", async () => {
    const team: Team = {
      id: "team-new",
      name: "api",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/api", index: 1 } },
    };
    act(() =>
      deck.hydrate(
        deckOf(
          [
            { id: "member", agentType: "claude", team: { teamId: "team-new", role: "lead" } },
            { id: "other", agentType: "claude" },
          ],
          { teams: [team] },
        ),
      ),
    );
    await settle();
    let land!: () => void;
    settling.set(
      "team-new",
      new Promise((resolve) => {
        land = () => resolve("resolved");
      }),
    );
    let archiving!: Promise<unknown>;
    act(() => {
      archiving = agentRun.archive(ref());
    });
    await settle();

    act(() => {
      expect(agentRun.restore(ref())).toBe("restored");
    });
    await act(async () => {
      land();
      await archiving;
    });

    expect(ws1().archived).toBeUndefined();
    // Nothing after the restore: no take-back, no settle.
    expect(disarms.asked).toEqual([]);
    // What the archive had done stays done — honestly stopped.
    expect(idleOf("other")).toMatchObject({ reason: "suspended" });
  });

  it("restore wakes nobody: the workspace comes back into view, every agent as the archive left it", async () => {
    act(() => deck.hydrate(deckOf([{ id: "running", agentType: "claude" }])));
    await settle();
    await act(async () => {
      await agentRun.archive(ref());
    });
    const startsBefore = pty.acquired.length;

    act(() => {
      expect(agentRun.restore(ref())).toBe("restored");
    });
    await settle();

    expect(deck.activeId).toBe("ws-1");
    expect(ws1().archived).toBeUndefined();
    expect(idleOf("running")).toMatchObject({ reason: "suspended" });
    expect(pty.acquired.length).toBe(startsBefore);
    expect(peekPaneSpawnSpec("running")).toBeUndefined();
    act(() => {
      expect(agentRun.restore(ref())).toBe("not-archived");
    });
  });

  it("restore drops a plan that landed after the archive began — its directory was taken back since", async () => {
    act(() => deck.hydrate(deckOf([{ id: "late", agentType: "claude" }])));
    await settle();
    await act(async () => {
      await agentRun.archive(ref());
    });
    // A build in flight at the archive caches its plan after the archive's
    // own drop; its planting was refused, so the plan would start an agent
    // without what it needs in its directory.
    act(() => {
      plans.specs.set("late", { command: "claude", args: [], env: [] });
      plans.notify();
    });

    act(() => {
      agentRun.restore(ref());
    });
    expect(peekPaneSpawnSpec("late")).toBeUndefined();
  });

  it("refuses to archive a workspace a confirmed close is ending", async () => {
    const team: Team = {
      id: "team-new",
      name: "api",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/api", index: 1 } },
    };
    act(() => deck.hydrate(deckOf([{ id: "member", agentType: "claude", team: { teamId: "team-new", role: "lead" } }], { teams: [team] })));
    await settle();
    let publish!: (made: null) => void;
    published.set(
      "team-new",
      new Promise((resolve) => {
        publish = resolve;
      }),
    );
    const held = ref();
    let closing!: Promise<unknown>;
    act(() => {
      closing = agentRun.close({ kind: "workspace", workspace: held, deleteWorktrees: false, worktrees: [] });
    });
    await settle();

    await act(async () => {
      expect(await agentRun.archive(held)).toBe("closing");
    });
    expect(ws1().archived).toBeUndefined();

    await act(async () => {
      publish(null);
      await closing;
    });
    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-2"]);
  });

  it("a close waits for the archive's pass instead of racing it", async () => {
    const team: Team = {
      id: "team-new",
      name: "api",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/api", index: 1 } },
    };
    act(() => deck.hydrate(deckOf([{ id: "member", agentType: "claude", team: { teamId: "team-new", role: "lead" } }], { teams: [team] })));
    await settle();
    let land!: () => void;
    settling.set(
      "team-new",
      new Promise((resolve) => {
        land = () => resolve("failed");
      }),
    );
    let archiving!: Promise<unknown>;
    act(() => {
      archiving = agentRun.archive(ref());
    });
    await settle();

    await act(async () => {
      await agentRun.close({ kind: "workspace", workspace: ref(), deleteWorktrees: false, worktrees: [] });
    });
    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2"]);

    await act(async () => {
      land();
      await archiving;
    });
    expect(ws1().archived?.phase).toBe("archived");
  });
});

describe("finishing an archive the last run left undone", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    settling.clear();
    disarms.asked = [];
    disarms.ok = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("finishes one found half-done — even a pane the marker never reached — with no workspace open", async () => {
    // What a marker this build could not read becomes: "archiving", its
    // panes as the document had them.
    const state = deckOf([{ id: "unmarked", agentType: "claude" }], { archived: { at: AT, phase: "archiving" } });
    act(() => deck.hydrate({ ...state, workspaces: [state.workspaces[0]], activeId: "" }));
    await settle();

    expect(ws1().archived).toEqual({ at: AT, phase: "archived" });
    expect(idleOf("unmarked")).toEqual({ reason: "suspended", at: AT });
    expect(disarms.asked).toEqual(["ws-1"]);
    expect(pty.acquired).toEqual([]);
  });

  it("retries exactly what the last pass owed, once, and clears what now succeeds", async () => {
    act(() =>
      deck.hydrate(
        deckOf([{ id: "stuck", agentType: "claude", idle: { reason: "suspended", at: AT } }], {
          archived: { at: AT, phase: "archived", warnings: { reaps: ["stuck"], disarm: true } },
        }),
      ),
    );
    await settle();

    // After a restart there is no process left to end; the take-back runs again.
    expect(disarms.asked).toEqual(["ws-1"]);
    expect(ws1().archived).toEqual({ at: AT, phase: "archived" });
  });

  it("leaves what still fails for the next launch, without retrying in a loop", async () => {
    disarms.ok = false;
    act(() =>
      deck.hydrate(
        deckOf([], { archived: { at: AT, phase: "archived", warnings: { reaps: [], disarm: true } } }),
      ),
    );
    await settle();
    act(() => deck.updateWorkspace(present(deck.workspaces.find((w) => w.id === "ws-2"), "ws-2"), { name: "renamed" })); // any later reconcile
    await settle();

    expect(disarms.asked).toEqual(["ws-1"]);
    expect(ws1().archived?.warnings).toEqual({ reaps: [], disarm: true });
  });
});
