// @vitest-environment happy-dom
import { emptyJournal } from "../domain/journal";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckState, PaneIdle } from "../domain/deck";
import { EMPTY_SPAWN_CONTEXT } from "../domain/agents";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  buildResumeSpec,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
  resetPaneSpawnSpecs,
} from "./spawnSpecs";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { createDeckStore } from "./deckStore";
import { useRevive, type ResumeRequest, type ReviveApi } from "./useRevive";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ipc = vi.hoisted(() => ({
  probeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => ({ probeWorktree: ipc.probeWorktree }));

// Resume plans are built through the agent plugins' hooks; the seam is
// mocked with a tiny cache so these tests assert revive POLICY (when a
// resume plan is requested) — the plan CONTENT is the plugin tests' job.
/** A gate a test can hold the build open on, WITHOUT replacing the
 * implementation — a replaced one caches no plan, and the re-stamp under test
 * needs a plan to re-stamp. */
const gate = vi.hoisted(() => ({ build: null as Promise<void> | null }));

vi.mock("./spawnSpecs", () => {
  const specs = new Map<string, unknown>();
  return {
    buildResumeSpec: vi.fn(
      async (
        _plugins: unknown,
        _agentType: string,
        facts: { paneId: string },
        _ctx: unknown,
        resumeId: string,
        origin: "restore" | "manual",
      ) => {
        if (gate.build) await gate.build;
        specs.set(facts.paneId, {
          args: ["--resume", resumeId],
          env: [],
          resumeOrigin: origin,
        });
        return true;
      },
    ),
    peekPaneSpawnSpec: (id: string) =>
      specs.get(id) as { args: string[]; resumeOrigin?: string } | undefined,
    // A refused manual wake drops the half-built plan, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec: vi.fn((id: string) => specs.delete(id)),
    markPaneResumeOrigin: vi.fn((id: string, origin: string) => {
      const spec = specs.get(id) as Record<string, unknown> | undefined;
      if (spec) specs.set(id, { ...spec, resumeOrigin: origin });
    }),
    resetPaneSpawnSpecs: () => specs.clear(),
  };
});
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: {} }),
}));

let deck: Deck;
let revive: ReviveApi;
const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

// The catalog the revive gate consults — swappable per test (the id set is
// open: revive must skip panes whose agent no plugin provides).
const catalog = {
  agents: ["claude", "codex", "opencode"].map((id) => ({
    id,
    label: id,
    command: id,
    supportsYolo: false,
    installed: true,
    path: null,
    usageCapabilities: ["paneTelemetry", "accountLimits"] as const,
  })),
  ready: true,
};

function Probe() {
  // Fresh per mount (a bare call would rebuild it on every render).
  const [store] = useState(createDeckStore);
  deck = useDeck(store);
  revive = useRevive(deck, catalog.agents, ctx, catalog.ready);
  return null;
}

/** A deck with one idle (restored) claude pane; `pane` overrides fields. */
const restored = (pane: object): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude", idle: { reason: "waking", origin: "restore" }, ...pane },
      ],
    },
  ],
  activeId: "ws-1",
  journal: emptyJournal,
  viewByWs: {},
});

/** Let the probe→validate→revive promise chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("useRevive — session policy", () => {
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
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];

  it("a recorded binding is TRUSTED and resumed — no store is read", async () => {
    // The binding came from the pane's own process (the reporter posts at
    // session creation), so it existed; a session deleted since fails the
    // resume VISIBLY in the terminal — accepted, rare, uniform. The app
    // never opens an agent's session store.
    act(() => deck.hydrate(restored({ session: { id: "old", boundAt: "t" } })));
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "old"]);
    expect(pane().session).toEqual({ id: "old", boundAt: "t" }); // kept
    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      {
        paneId: "pane-1",
        workspace: {
          id: "ws-1",
          instance: deck.workspaces[0].instance,
        },
        cwd: "/repo",
        branch: undefined,
        yolo: undefined,
        wsSkillRoots: ["/repo"],
      },
      expect.anything(),
      "old",
      "restore",
    );
  });

  it("an unbound pane starts FRESH — never matched by directory", async () => {
    // Every agent reports its id post-hoc now, so an unbound pane is normal
    // (never messaged, a mid-TUI /new, or a reporter that couldn't arm).
    // Matching the newest session in the pane's cwd would resume a FOREIGN
    // conversation whenever panes share a cwd (the default — a worktree is
    // optional): unbound wakes fresh, with no resume spec.
    act(() => deck.hydrate(restored({ agentType: "codex", cwd: "/repo" })));
    await settle();

    expect(pane().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined(); // fresh spawn plan
  });

  it("a REMOTE pane wakes fresh — no directory probe, no resume", async () => {
    // A remote pane runs against a VPS endpoint: it has no local dir to probe
    // (so a gone workspace cwd never blocks it) and is fresh-session only, so
    // even a stale `session` is ignored — never handed to the resume path
    // (which would spawn locally and drop the endpoint).
    ipc.probeWorktree.mockClear();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() =>
      deck.hydrate(
        restored({
          agentType: "codex",
          remoteEndpoint: "ws://vps:4500",
          session: { id: "stale", boundAt: "t" },
        }),
      ),
    );
    await settle();

    expect(pane().idle).toBeUndefined(); // woken
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined(); // fresh, not resumed
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(ipc.probeWorktree).not.toHaveBeenCalled(); // no local dir to probe
  });

  it("an agent no plugin provides stays idle — and KEEPS its binding", async () => {
    // Waking would spawn the bare id as a command; the binding may resume
    // perfectly once the plugin is re-enabled. No wake, no probe.
    act(() =>
      deck.hydrate(
        restored({ agentType: "gemini", session: { id: "old", boundAt: "t" } }),
      ),
    );
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
    expect(pane().session).toEqual({ id: "old", boundAt: "t" });
  });

  it("nothing wakes before the catalog is ready", async () => {
    // Before plugin bootstrap EVERY id is absent from the catalog — waking
    // then would misjudge every pane. The effect waits for the ready flag.
    catalog.ready = false;
    act(() => root.render(createElement(Probe)));
    act(() => deck.hydrate(restored({})));
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("a gone directory blocks revival instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();

    expect(pane().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(revive.blocked["pane-1"]).toBe("/repo/wt-gone");
  });

  it("closing a blocked pane reaps its blocked entry", async () => {
    // Pane ids are never reused, so entries left behind by closed panes
    // would accumulate for the whole session.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ cwd: "/repo/wt-gone" })));
    await settle();
    expect(revive.blocked["pane-1"]).toBe("/repo/wt-gone");

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();
    expect(revive.blocked).toEqual({});
  });
});

describe("useRevive — resuming a suspended pane", () => {
  let root: Root;

  /** A deck with one bound pane on a worktree, suspended unless overridden —
   * some cases need the same pane in a different idle state. */
  const withPane = (pane: object = {}): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            cwd: "/repo/wt-1",
            branch: "kd/ws/1",
            session: { id: "s-1", boundAt: "t" },
            idle: { reason: "suspended", at: "2026-07-25T09:00:00.000Z" },
            ...pane,
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const pane = () => deck.workspaces[0].panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("stays put until asked — the sweep never wakes it on its own", async () => {
    act(() => deck.hydrate(withPane()));
    await settle();

    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("resumes into its worktree with its recorded session", async () => {
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toBeUndefined(); // live: the terminal mounts
    expect(ipc.probeWorktree).toHaveBeenCalledWith("/repo/wt-1");
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "s-1"]);
  });

  it("builds the resume plan as MANUAL — a rejected id must not silently start a new conversation", async () => {
    // The boot restore path stamps "restore", which arms a one-shot fallback:
    // if the CLI refuses the recorded id and dies without reporting, the pane
    // respawns fresh AND its binding is wiped, with no notification. That is
    // right for a launch nobody is watching and wrong for a button the user
    // pressed after being promised this session by name.
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
      expect.anything(),
      "s-1",
      "manual",
    );
  });

  it("a resume whose plan cannot be BUILT stays stopped instead of starting a new conversation", async () => {
    // The second door onto the same failure: the CLI never even runs. A
    // plugin with no resume.plan hook returns false without throwing, and
    // waking anyway would let the fresh sweep spawn a NEW conversation whose
    // reporter then overwrites the binding the card promised by name.
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    // Back down where it was, with its stamp and its binding intact…
    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    // …and the card can say why.
    expect(revive.wakeFailed["pane-1"]).toContain("resume plan");
  });

  it("a BOOT restore whose plan cannot be built still degrades to a fresh wake", async () => {
    // The documented trade the manual path deliberately does not take:
    // nobody is watching a launch, and an empty pane beats a dead one.
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() =>
      deck.hydrate(withPane({ idle: { reason: "waking", origin: "restore" } })),
    );
    await settle();

    expect(pane().idle).toBeUndefined(); // woken
    expect(revive.wakeFailed["pane-1"]).toBeUndefined();
  });

  it("a resume whose resume.plan THROWS is treated the same way", async () => {
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("hook exploded"));
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(revive.wakeFailed["pane-1"]).toContain("hook exploded");
  });

  it("asking again clears the last refusal", async () => {
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => revive.resume("ws-1", "pane-1"));
    await settle();
    expect(revive.wakeFailed["pane-1"]).toBeDefined();

    // The gesture that asks also forgets — a card must not keep explaining a
    // failure the user is already retrying.
    act(() => revive.resume("ws-1", "pane-1"));
    await settle();

    expect(revive.wakeFailed["pane-1"]).toBeUndefined();
    expect(pane().idle).toBeUndefined(); // the retry succeeded
  });

  it("a pane RESTORED at launch still builds as restore — only a click is manual", async () => {
    // The distinction lives on the pane's own marker, so the sweep cannot
    // guess wrong: a pane hydration woke keeps the boot semantics.
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    act(() =>
      deck.hydrate(withPane({ idle: { reason: "waking", origin: "restore" } })),
    );
    await settle();

    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
      expect.anything(),
      "s-1",
      "restore",
    );
  });

  it("a DELETED worktree blocks the resume instead of spawning into nowhere", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(withPane()));
    await settle();

    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    // No process, no resume plan: the pane goes back DOWN where it came from,
    // stamp intact, and reports the missing directory so its card can explain
    // itself. Leaving it `waking` would strand it — that state is never
    // persisted, so a restart would lose the suspend entirely.
    expect(pane().idle).toEqual({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" });
    expect(revive.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    // The binding survives — nothing has decided to abandon that session yet.
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });

  it("blocked once, probed once — a wedged pane never loops on the sweep", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();
    await settle();

    expect(ipc.probeWorktree).toHaveBeenCalledTimes(1);
  });

  it("start-fresh relocates it to the workspace folder — and DROPS the session", async () => {
    // The worktree is gone; the workspace folder it relocates INTO is not.
    ipc.probeWorktree.mockImplementation((dir: string) =>
      Promise.resolve({
        exists: dir === "/repo",
        isWorktree: false,
        empty: false,
        branch: null,
      }),
    );
    act(() => deck.hydrate(withPane()));
    await settle();
    act(() => revive.resume("ws-1", "pane-1"));
    await settle();

    act(() => revive.startFresh("ws-1", "pane-1"));
    await settle();

    expect(revive.blocked).toEqual({});
    expect(pane().idle).toBeUndefined();
    // The worktree is gone, so the conversation recorded against it cannot be
    // resumed here: cwd, branch and binding all go, and the pane starts new.
    expect(pane().cwd).toBeUndefined();
    expect(pane().branch).toBeUndefined();
    expect(pane().session).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
  });
});

describe("useRevive — waking across workspace switches", () => {
  let root: Root;

  /** Two workspaces, ws-1 active, one pane each with the given idle reason. */
  const twoWorkspaces = (idle: PaneIdle): DeckState => ({
    workspaces: ["ws-1", "ws-2"].map((id) => ({
      id,
      instance: createWorkspaceInstance(),
      name: id,
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: `${id}-pane`, agentType: "claude", idle }],
    })),
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const paneOf = (wsId: string) =>
    deck.workspaces.find((w) => w.id === wsId)!.panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("RESTORED panes wake lazily: the active workspace at launch, the other on its first activation", async () => {
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();

    expect(paneOf("ws-1").idle).toBeUndefined(); // launched with the deck
    expect(paneOf("ws-2").idle).toEqual({ reason: "waking", origin: "restore" }); // still asleep

    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-2").idle).toBeUndefined(); // woken by the switch
  });

  it("PARKED panes stay stopped through a workspace switch, not just at launch", async () => {
    act(() => deck.hydrate(twoWorkspaces({ reason: "parked" })));
    await settle();

    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-1").idle).toEqual({ reason: "parked" });
    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });
});

describe("useRevive — a blocked pane can be re-probed", () => {
  let root: Root;

  const blockedDeck = (): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            cwd: "/repo/wt-1",
            session: { id: "s-1", boundAt: "t" },
            idle: { reason: "suspended", at: "2026-07-25T09:00:00.000Z" },
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const pane = () => deck.workspaces[0].panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset();
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("looks again when the folder comes back, keeping the session", async () => {
    // A blocked pane is skipped for the rest of the session, so without a
    // retry an unmounted volume left it stuck behind a card whose only other
    // exit throws the binding away.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(blockedDeck()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();
    expect(revive.blocked["pane-1"]).toBe("/repo/wt-1");

    // The volume is back.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => revive.resume("ws-1", "pane-1"));
    await settle();

    expect(revive.blocked["pane-1"]).toBeUndefined();
    expect(pane().idle).toBeUndefined(); // live again
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "s-1"]);
  });

  it("stays blocked, with its stamp, when the folder is still gone", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(blockedDeck()));
    await settle();
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    act(() => revive.resume("ws-1", "pane-1"));
    await settle();

    expect(revive.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });
});

describe("useRevive — a request that lands mid-flight", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    ipc.probeWorktree.mockReset();
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];
  const origins = () =>
    vi.mocked(buildResumeSpec).mock.calls.map((call) => call[5]);

  /** A probe held open, so a gesture can land while the wake is in flight. */
  const heldProbe = () => {
    let release!: () => void;
    ipc.probeWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exists: true, isWorktree: false, empty: false, branch: null });
        }),
    );
    return () => release();
  };

  it("serves a resume asked for DURING the probe as the user's, not as a boot restore", async () => {
    // The sweep holds the pane in its in-flight set, so the request starts no
    // second attempt — the one already running has to notice it. Judging by
    // the origin captured when the probe went out is how a resume the user
    // asked for by name came up as a fresh conversation instead.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    // The pane is mid-probe; ask for it by name (the `agent.resume` path).
    let asked: ResumeRequest | undefined;
    act(() => {
      asked = revive.resume("ws-1", "pane-1");
    });
    expect(asked).toBe("resuming");
    release();
    await settle();

    expect(origins()).toEqual(["manual"]);
    expect(pane().idle).toBeUndefined();
  });

  it("clears the failure flag when a BOOT restore's plan build throws", async () => {
    // The build that throws also marks the pane as plan-failed inside
    // spawnSpecs, so waking it without dropping that flag lands it on the
    // "Couldn't start this agent" tile — while the code here says a restore
    // that fails "wakes fresh". The manual branch drops the flag and says
    // why; the restore branch has to do the same or it doesn't wake fresh at
    // all, it wakes broken.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("hook blew up"));
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pane().idle).toBeUndefined(); // woken, as documented
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    // Nobody asked for this wake, so nothing is reported on the card.
    expect(revive.wakeFailed).toEqual({});
  });

  it("sees a request dispatched outside a React event", async () => {
    // `agent.resume` reached from MCP, the plugin bridge or a Tauri callback
    // dispatches from a promise continuation rather than a React event, so
    // the store holds the request before any render carries it. The sweep
    // reads the origin through the hook's deck, and this pins that the two
    // cannot come apart: if they ever did, the user's named resume would be
    // served as a boot restore — the one origin allowed to become a new
    // conversation. Deliberately NOT wrapped in act(): the un-flushed
    // dispatch is the point.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    deck.requestPaneWake("ws-1", "pane-1");
    release();
    await settle();

    expect(origins()).toEqual(["manual"]);
  });

  it("re-stamps a plan already built as a restore when the request arrives mid-BUILD", async () => {
    // The origin is baked into the cached plan — it is what arms the one-shot
    // fall back to a fresh conversation. A plan built as a restore therefore
    // cannot serve a resume the user asked for.
    // Held open, but still caching a plan the way a real build does — the
    // re-stamp has to have something to re-stamp.
    let releaseBuild!: () => void;
    gate.build = new Promise<void>((resolve) => (releaseBuild = resolve));
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => {
      revive.resume("ws-1", "pane-1");
    });
    releaseBuild();
    await settle();

    // Built ONCE. The origin is a field of the assembled plan — it never
    // reaches the plugin's `resume.plan` hook — so re-running that hook to
    // change it would run a third party's code twice for something it cannot
    // see. The cached plan is re-stamped instead.
    expect(origins()).toEqual(["restore"]);
    expect(peekPaneSpawnSpec("pane-1")?.resumeOrigin).toBe("manual");
    expect(pane().idle).toBeUndefined();
  });

  it("drops the outcome of a wake the user CANCELLED mid-probe", async () => {
    // Suspending a rising pane cancels the wake. Building a plan for it
    // afterwards would hand a stopped pane a live resume spec, and reporting
    // the attempt would explain a failure nobody is waiting on.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => deck.suspendPane("ws-1", "pane-1"));
    release();
    await settle();

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(origins()).toEqual([]); // no plan built for a cancelled wake
    expect(revive.wakeFailed).toEqual({});
  });

  it("does not BLOCK a pane the user stopped while its folder was being probed", async () => {
    // The gone-folder verdict arrives without going through `wake` at all, so
    // it needs the same guard: marking the pane blocked would leave the
    // suspended card explaining a directory the user never asked about, and a
    // blocked pane is skipped by the sweep until something clears it.
    let release!: () => void;
    ipc.probeWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exists: false, isWorktree: false, empty: false, branch: null });
        }),
    );
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => deck.suspendPane("ws-1", "pane-1"));
    release();
    await settle();

    expect(revive.blocked).toEqual({});
    expect(pane().idle).toMatchObject({ reason: "suspended" });
  });
});

describe("useRevive — a pane asked for by name in another workspace", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** Two workspaces, `ws-1` active; the pane to resume lives in `ws-2`. */
  const twoWorkspaces = (idle: PaneIdle): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "one",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude" }],
      },
      {
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/other",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-2",
            agentType: "claude",
            idle,
            session: { id: "s-2", boundAt: "t" },
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const background = () => deck.workspaces[1].panes[0];

  it("is served where it stands, instead of waiting for a workspace switch", async () => {
    // `agent.resume` takes a workspace argument precisely so it can reach a
    // pane that isn't on screen. Marking such a pane and then never sweeping
    // it left it neither running nor durably stopped: the suspend is dropped
    // from state (and from disk, it is the durable half) while nothing acts
    // on the request, so quitting before switching lost the suspend.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    expect(background().idle).toMatchObject({ reason: "suspended" });

    act(() => {
      revive.resume("ws-2", "pane-2");
    });
    await settle();

    expect(background().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-2")?.args).toEqual(["--resume", "s-2"]);
  });

  it("refuses a pane no plugin can start, instead of stranding it", async () => {
    // The sweep skips a pane whose agent no plugin provides, so marking it
    // `waking` puts it somewhere nothing will ever settle: the durable
    // `suspended` stamp is gone from state (and from the next save), the
    // sweep won't touch it, and every "is this running" answer flips to yes
    // for an agent that cannot start. Refusing keeps the pane exactly as it
    // was, and the caller is told why.
    act(() =>
      deck.hydrate(
        twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" }),
      ),
    );
    await settle();
    act(() => {
      deck.workspaces[1].panes[0].agentType = "retired-cli";
    });

    expect(revive.resume("ws-2", "pane-2")).toBe("unavailable");
    expect(background().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
  });

  it("still leaves a RESTORED pane in a background workspace alone", async () => {
    // The lazy-revive policy is about panes that rise by themselves: waking a
    // whole background workspace at launch is what it exists to prevent.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();

    expect(background().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
  });
});
