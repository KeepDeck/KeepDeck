// @vitest-environment happy-dom
import { provisioningCard } from "../../domain/deck";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PANES,
  Probe,
  agentRun,
  buildResumeSpec,
  catalog,
  createWorkspaceInstance,
  ctx,
  deck,
  emptyJournal,
  ipc,
  peekPaneSpawnSpec,
  provisionedAs,
  provisions,
  pty,
  resetPaneSpawnSpecs,
  settle,
} from "./testSupport";
import type {
  DeckState,
  Pane,
  SpawnConfig,
  SpawnPluginAccess,
  WorkspaceCreationResult,
} from "./testSupport";

describe("agent orchestrator —what resume answers", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const only = (pane: object) =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude", ...pane }],
      }),
    );

  it("says a live pane has nothing to bring back", () => {
    // A caller reporting success for this would be lying, and the command
    // surfaces the answer as a sentence.
    only({});
    expect(agentRun.resume("ws-1", "pane-1")).toBe("running");
  });

  it("tells a pane mid-create apart from a running one", async () => {
    // Its own doc: telling the user a pane mid-create is already running is
    // simply false — it has never run, so there is no session to come back to.
    only({
      location: {
        kind: "provisioning",
        intent: { repo: "/repo", path: "/wt/a", index: 1 },
      },
    });
    await settle();
    expect(agentRun.resume("ws-1", "pane-1")).toBe("provisioning");
  });

  it("says gone for a pane, and for a workspace, that is not there", () => {
    only({ idle: { reason: "parked" } });
    expect(agentRun.resume("ws-1", "nope")).toBe("gone");
    expect(agentRun.resume("nope", "pane-1")).toBe("gone");
  });
});

describe("agent orchestrator —a new pane arriving", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** One empty workspace in worktree mode, its ref captured. */
  const instance = () => deck.workspaces[0].instance;
  const seed = (panes: Pane[] = []): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        panes,
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const card = (over: object = {}): Pane => ({
    id: "pane-9",
    agentType: "claude",
    location: {
      kind: "provisioning",
      intent: { repo: "/repo", path: "/wt/a", index: 1 },
    },
    ...over,
  });

  it("lands a plain pane and leaves the worktree runner alone", async () => {
    act(() => deck.hydrate(seed()));
    let outcome;
    await act(async () => {
      outcome = agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: { id: "pane-9", agentType: "claude" },
      });
    });
    expect(outcome).toEqual({ kind: "created" });
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-9"]);
    expect(provisions).toEqual([]);
  });

  it("starts the worktree create behind a pane that arrives as a card", async () => {
    act(() => deck.hydrate(seed()));
    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card(),
      });
    });
    expect(provisions).toHaveLength(1);
    expect(provisions[0].map((p) => p.id)).toEqual(["pane-9"]);
  });

  it("issues the create under the workspace's name, read from the deck as it lands", async () => {
    // The auto branch name's workspace half is not on the card: the landing
    // reads it from the workspace the pane lands in, at that moment.
    act(() => deck.hydrate(seed()));
    act(() => deck.renameWorkspace("ws-1", "renamed"));
    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card(),
      });
    });
    expect(provisionedAs).toEqual(["renamed"]);
  });

  it("refuses a workspace whose id now names a REPLACEMENT", async () => {
    // `ws-N` is a reusable slot. A creation surface decides asynchronously —
    // a repo inspect, a worktree suggestion — and the workspace it started
    // from can be closed and its slot reissued before it gets here.
    act(() => deck.hydrate(seed()));
    const stale = instance();
    act(() => deck.hydrate(seed()));

    let outcome;
    await act(async () => {
      outcome = agentRun.createPane({
        workspace: { id: "ws-1", instance: stale },
        pane: card(),
      });
    });
    expect(outcome).toEqual({ kind: "gone" });
    expect(deck.workspaces[0].panes).toEqual([]);
    // Nothing was added, so nothing may be created on disk for it.
    expect(provisions).toEqual([]);
  });

  it("refuses a full workspace rather than provisioning an ownerless worktree", async () => {
    // The add is a silent no-op once the workspace is full. Kicking the
    // create off anyway would leave a git worktree on disk with no pane to
    // own it, and nothing that would ever clean it up.
    act(() =>
      deck.hydrate(
        seed(
          Array.from({ length: MAX_PANES }, (_, i) => ({
            id: `pane-${i + 1}`,
            agentType: "claude" as const,
          })),
        ),
      ),
    );
    let outcome;
    await act(async () => {
      outcome = agentRun.createPane({
        workspace: { id: "ws-1", instance: instance() },
        pane: card(),
      });
    });
    expect(outcome).toEqual({ kind: "full" });
    expect(deck.workspaces[0].panes).toHaveLength(MAX_PANES);
    expect(provisions).toEqual([]);
  });

  it("drops a refused pane's cached plan — nothing will ever run it", async () => {
    // The plan-first flows (a journal resume, a fork) build and cache a plan
    // keyed by the pane id BEFORE the pane exists. Pane ids are never reused,
    // so a plan left behind by a refusal sits in the cache for the life of
    // the process.
    act(() => deck.hydrate(seed()));
    const stale = instance();
    act(() => deck.hydrate(seed()));
    await buildResumeSpec(
      {} as SpawnPluginAccess,
      "claude",
      { paneId: "pane-9", workspace: { id: "ws-1", instance: stale }, cwd: "/repo" },
      ctx,
      "s-1",
      "manual",
    );
    expect(peekPaneSpawnSpec("pane-9")).toBeDefined();

    await act(async () => {
      agentRun.createPane({
        workspace: { id: "ws-1", instance: stale },
        pane: card(),
      });
    });
    expect(peekPaneSpawnSpec("pane-9")).toBeUndefined();
  });
});

describe("agent orchestrator —a new workspace", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const config = (over: Partial<SpawnConfig> = {}): SpawnConfig => ({
    name: "",
    cwd: "/repo",
    worktreeBaseDir: null,
    ...over,
  });

  const create = (over: Partial<SpawnConfig> = {}) => {
    let result!: WorkspaceCreationResult;
    act(() => {
      result = agentRun.createWorkspace(config(over));
    });
    return result;
  };

  it("reuses the highest sequence after its workspace is deleted", () => {
    create();
    create();
    create();
    expect(deck.workspaces.map((ws) => [ws.id, ws.name])).toEqual([
      ["ws-1", "workspace-1"],
      ["ws-2", "workspace-2"],
      ["ws-3", "workspace-3"],
    ]);

    const oldInstance = deck.workspaces[2].instance;
    act(() => deck.closeWorkspace("ws-3"));
    create();

    expect(deck.workspaces.map((ws) => [ws.id, ws.name])).toEqual([
      ["ws-1", "workspace-1"],
      ["ws-2", "workspace-2"],
      ["ws-3", "workspace-3"],
    ]);
    expect(deck.workspaces[2].instance).not.toBe(oldInstance);
  });

  it("keeps advancing past the maximum when only an interior id is deleted", () => {
    create();
    create();
    create();

    act(() => deck.closeWorkspace("ws-2"));
    create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-3", "ws-4"]);
  });

  it("allocates distinct ids to creates queued in the same React batch", () => {
    act(() => {
      agentRun.createWorkspace(config());
      agentRun.createWorkspace(config());
    });

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2"]);
  });

  it("can release and reuse the maximum inside one React batch", () => {
    create();
    create();
    create();

    act(() => {
      deck.closeWorkspace("ws-3");
      agentRun.createWorkspace(config());
    });

    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  it("does not start a create when the numeric namespace is exhausted", () => {
    const maxId = `ws-${Number.MAX_SAFE_INTEGER}`;
    act(() =>
      deck.hydrate({
        workspaces: [
          {
            id: maxId,
            instance: createWorkspaceInstance(),
            name: "maximum",
            cwd: "/repo",
            worktreeBaseDir: null,
            panes: [],
          },
        ],
        activeId: maxId,
        journal: emptyJournal,
        viewByWs: {},
      }),
    );

    const result = create();

    expect(deck.workspaces.map((ws) => ws.id)).toEqual([maxId]);
    expect(result).toEqual({ ok: false, reason: "sequence-exhausted" });
    expect(provisions).toEqual([]);
  });

  it("is born empty, and asks the worktree runner for nothing", () => {
    // Nothing spawns at create time, so there is no worktree to create here
    // either — every pane arrives later through its own request, carrying the
    // location a create would need.
    create({ worktreeBaseDir: "/wt" });
    expect(deck.workspaces[0].panes).toEqual([]);
    expect(provisions).toEqual([]);
  });
});

describe("agent orchestrator —retrying a failed worktree create", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** A workspace with one FAILED provisioning card. */
  const failedCard = (intent: object) =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            location: {
              kind: "provisioning",
              intent: { repo: "/repo", path: "/repo-wt/x", index: 1, ...intent },
              error: "boom",
            },
          },
        ],
      }),
    );

  it("clears the error before re-issuing, so the card goes back to creating", () => {
    failedCard({ path: "/repo-wt/x", branch: "kd/x" });
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    expect(provisioningCard(deck.workspaces[0].panes[0])?.error).toBeUndefined();
    expect(provisions).toHaveLength(1);
  });

  it("issues the Retry under the name the workspace has NOW, not the one the card was born with", () => {
    // A rename between the failure and the Retry changes the auto branch
    // name — on purpose. The card records only its number; a name written
    // into it (as every intent once carried) would have named the branch
    // after a workspace that no longer exists by that name.
    failedCard({ path: "/repo-wt/x" });
    act(() => deck.renameWorkspace("ws-1", "renamed"));
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    expect(provisionedAs).toEqual(["renamed"]);
  });

  it("ignores a pane with no create intent, and one that is not there", () => {
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude" }],
      }),
    );
    act(() => agentRun.retryProvisioning("ws-1", "pane-1"));
    act(() => agentRun.retryProvisioning("ws-1", "nope"));
    expect(provisions).toEqual([]);
  });
});
