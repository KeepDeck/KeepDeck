import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, StatusNormalizer } from "@keepdeck/plugin-api";
import {
  createAgentStatusTracker,
  type AgentStatusTracker,
} from "./agentStatusTracker";
import {
  createAgentStatusChannel,
  type PaneKeyPort,
  type SessionLivenessPort,
  type StatusDeclarationsPort,
} from "./agentStatusChannel";
import type { DeckWatch } from "./deckStore";
import { deckStateOf } from "./deckStore.testSupport";
import { createPaneAttribution } from "./paneAttribution";
import type { PaneReportEvent } from "./verifiedPaneReports";
import { present } from "@keepdeck/plugin-api/testing";
import { statusEdge } from "../testing/values.test-support";
import { maybeRecord } from "../testing/values.test-support";

/** Every report is the main agent's and may move the pane: the channel
 * under test is the wiring, not the admission rule, which has its own tests. */
const mainAgent = () => ({ event: null, actor: "main" as const, status: true });

const ipc = vi.hoisted(() => ({
  onAgentStatus: vi.fn<
    (handler: (report: PaneReportEvent) => void) => Promise<() => void>
  >(() => Promise.resolve(() => {})),
  peekPaneSpawnSpec: vi.fn(() => ({ token: "tok" })),
}));
vi.mock("../ipc/status", () => ({ onAgentStatus: ipc.onAgentStatus }));
vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: ipc.peekPaneSpawnSpec }));
vi.mock("./ptyManager", () => ({
  paneSessionState: () => ({ kind: "live" }),
}));

const edgeNormalizer = (payload: unknown) =>
  statusEdge(payload);

/** A deck store holding one workspace with the given pane ids. */
/** These cases drive the tracker directly, never the bridge lane, so the
 * channel's attribution is only a constructor argument here — one that
 * admits nothing, so a case that DID start reporting through the lane would
 * fail loudly rather than quietly pass on a permissive fake. The lane's own
 * rule is covered in verifiedPaneReports.test.ts. */
const attribution = createPaneAttribution({
  workspaces: () => [],
  secretOf: () => undefined,
  swapSources: () => [],
});

const deckWith = (...paneIds: string[]) => {
  const listeners = new Set<() => void>();
  const stateOf = (ids: string[]) =>
    deckStateOf(ids.map((id) => ({ id, agentType: "claude" })));
  let state = stateOf(paneIds);
  const store: DeckWatch = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    store,
    setPanes(...next: string[]) {
      state = stateOf(next);
      for (const listener of [...listeners]) listener();
    },
  };
};

/** A contribution registry whose agent list can change under the channel. */
const agentsWith = () => {
  const listeners = new Set<() => void>();
  let entries: { entry: { id: string; status: AgentStatus } }[] = [
    { entry: { id: "claude", status: { normalize: edgeNormalizer, attribute: mainAgent } } },
  ];
  const registry: StatusDeclarationsPort = {
    list: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    registry,
    replace(next: typeof entries) {
      entries = next;
      for (const listener of [...listeners]) listener();
    },
  };
};

describe("createAgentStatusChannel", () => {
  let tracker: AgentStatusTracker;
  let sessionListeners: Set<() => void>;
  let kinds: Map<string, string>;
  let sessions: SessionLivenessPort;
  let keys: { port: PaneKeyPort; press: (paneId: string, data: string) => void };

  const exit = (paneId: string) => {
    kinds.set(paneId, "exited");
    for (const listener of [...sessionListeners]) listener();
  };

  beforeEach(() => {
    tracker = createAgentStatusTracker();
    sessionListeners = new Set();
    kinds = new Map();
    sessions = {
      subscribe(listener) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      state: (paneId) => ({ kind: kinds.get(paneId) ?? "live" }),
    };
    const keyListeners = new Set<(paneId: string, data: string) => void>();
    keys = {
      port: {
        subscribe(listener) {
          keyListeners.add(listener);
          return () => keyListeners.delete(listener);
        },
      },
      press: (paneId, data) => {
        for (const listener of [...keyListeners]) listener(paneId, data);
      },
    };
  });

  it("retires decoder metadata when a process dies before publishing any activity", () => {
    const agents = agentsWith();
    const normalize: StatusNormalizer = (payload, at, context) => {
      if (maybeRecord(payload)?.seed === true) return { kind: "status-reduction", state: "old-mode", events: [] };
      return { kind: "turn-start", at: context?.state === "old-mode" ? 999 : at };
    };
    agents.replace([{ entry: { id: "claude", status: { normalize, attribute: mainAgent } } }]);
    createAgentStatusChannel(deckWith("pane-1").store, agents.registry,
      tracker, sessions, attribution, keys.port);
    tracker.report("pane-1", { agent: "claude", seed: true }, 100);
    expect(tracker.getSnapshot().panes.size).toBe(0);
    exit("pane-1");
    kinds.set("pane-1", "live");
    tracker.report("pane-1", { agent: "claude" }, 200);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({ state: "working", since: 200 });
  });

  it("clears a pane's activity the moment its process exits", () => {
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);

    exit("pane-1");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
  });

  it("a failed spawn is swept like an exit — starting-window reports must not outlive it", () => {
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    // A hook beat the spawn promise; then the spawn rejected.
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });
    kinds.set("pane-1", "failed");
    for (const listener of [...sessionListeners]) listener();
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
  });

  it("only dead panes are swept — live neighbours keep their activity", () => {
    createAgentStatusChannel(
      deckWith("pane-1", "pane-2").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    tracker.report("pane-2", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });

    exit("pane-1");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
    expect(tracker.getSnapshot().panes.get("pane-2")).toMatchObject({
      state: "waiting",
    });
  });

  it("re-registers normalizers when the contributions change, last wins", () => {
    const agents = agentsWith();
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agents.registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);
    tracker.clear("pane-1");

    // The plugin re-activates with a NEW normalizer: only the replacement
    // may speak for the agent.
    agents.replace([
      {
        entry: {
          id: "claude",
          status: { normalize: () => ({ kind: "turn-end", at: 200 }), attribute: mainAgent },
        },
      },
    ]);
    tracker.report("pane-1", { agent: "claude", edge: null });
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "done",
    });
  });

  it("an agent losing its status voice clears its panes — no frozen lie", () => {
    const deck = deckWith("pane-1");
    const agents = agentsWith();
    createAgentStatusChannel(
      deck.store,
      agents.registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);

    // The plugin is DISABLED: claude leaves the contribution list whole.
    // Its process may live on, so no sweep would ever fire — the channel
    // must clear what the agent can no longer resolve.
    agents.replace([]);
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
  });

  it("retains only the deck's panes when membership changes", () => {
    const deck = deckWith("pane-1", "pane-2");
    createAgentStatusChannel(
      deck.store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    tracker.report("pane-2", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });

    deck.setPanes("pane-2");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
    expect(tracker.getSnapshot().panes.has("pane-2")).toBe(true);
  });

  it("feeds VERIFIED bridge reports into the tracker through the shared guard", async () => {
    const captured: {
      handler: ((report: { paneId: string; token: string; payload: unknown }) => void) | null;
    } = { handler: null };
    ipc.onAgentStatus.mockImplementationOnce((h) => {
      captured.handler = h;
      return Promise.resolve(() => {});
    });
    // The one case that reaches the lane, so it gets the real rule over its
    // own deck rather than the refuse-everything default above.
    const deck = deckWith("pane-1");
    createAgentStatusChannel(
      deck.store,
      agentsWith().registry,
      tracker,
      sessions,
      createPaneAttribution({
        workspaces: () => deck.store.getSnapshot().workspaces,
        secretOf: () => "tok",
        swapSources: () => [],
      }),
      keys.port,
    );
    await Promise.resolve();

    present(captured.handler, "the report handler")({
      paneId: "pane-1",
      token: "tok",
      payload: { agent: "claude", edge: { kind: "turn-start", at: 100 } },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);

    // A wrong token never reaches the store.
    present(captured.handler, "the report handler")({
      paneId: "pane-1",
      token: "forged",
      payload: { agent: "claude", edge: { kind: "turn-end", at: 200 } },
    });
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "working",
    });
  });

  it("a compaction is announced before the ask it rides on is answered", async () => {
    // claude's and codex's `SessionStart(compact)` both reports the rebuild
    // and asks for mail. Whatever the rebuild re-states (the team briefing)
    // has to be queued by the time that ask takes the queue.
    const captured: {
      handler: ((report: { paneId: string; token: string; payload: unknown }) => void) | null;
    } = { handler: null };
    ipc.onAgentStatus.mockImplementationOnce((h) => {
      captured.handler = h;
      return Promise.resolve(() => {});
    });
    const deck = deckWith("pane-1");
    const order: string[] = [];
    tracker.onContextRebuilt(() => order.push("rebuilt"));
    createAgentStatusChannel(
      deck.store,
      agentsWith().registry,
      tracker,
      sessions,
      createPaneAttribution({
        workspaces: () => deck.store.getSnapshot().workspaces,
        secretOf: () => "tok",
        swapSources: () => [],
      }),
      keys.port,
      () => {
        order.push("answered");
      },
    );
    await Promise.resolve();

    present(captured.handler, "the report handler")({
      paneId: "pane-1",
      token: "tok",
      payload: { agent: "claude", edge: { kind: "context-compacted", at: 100 } },
    });
    expect(order).toEqual(["rebuilt", "answered"]);
  });

  it("stops sweeping after dispose", () => {
    const channel = createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    channel.dispose();
    exit("pane-1");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);
  });

  /** Park `pane-1` on an approval prompt, the way a CLI's hook does. */
  const parkOnApproval = () => {
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
  };

  it("the user's own answer resolves a wait no agent reports resolved", () => {
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    parkOnApproval();

    keys.press("pane-1", "\r");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "working",
    });
  });

  it("typing or Enter cannot finish a multi-page/free-text question", () => {
    createAgentStatusChannel(deckWith("pane-1").store, agentsWith().registry,
      tracker, sessions, attribution, keys.port);
    tracker.report("pane-1", {
      agent: "claude", edge: { kind: "waiting", at: 100, reason: "question" },
    });
    for (const key of ["a", "\r", "\x1b[A"]) keys.press("pane-1", key);
    expect(tracker.getSnapshot().panes.get("pane-1"))
      .toEqual({ state: "waiting", since: 100, reason: "question" });
    tracker.report("pane-1", {
      agent: "claude", edge: { kind: "resumed", at: 200, reason: "question" },
    });
    expect(tracker.getSnapshot().panes.get("pane-1")?.state).toBe("working");
  });

  it("reading the question does not answer it", () => {
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    parkOnApproval();

    // Scrolling back to see what is being asked. Clearing here would replace
    // an honest amber with a "Working" that codex never takes back.
    keys.press("pane-1", "\x1b[A");
    keys.press("pane-1", "\x1b[5~");
    keys.press("pane-1", "\x1bb"); // macOS Alt+Left
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
  });

  it("answers only the pane that was typed into", () => {
    createAgentStatusChannel(
      deckWith("pane-1", "pane-2").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    parkOnApproval();
    tracker.report("pane-2", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });

    keys.press("pane-2", "y");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
    expect(tracker.getSnapshot().panes.get("pane-2")).toMatchObject({
      state: "working",
    });
  });

  it("typing in a pane with nothing to answer starts nothing", () => {
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    // A plain shell, or an agent pane that has reported nothing yet. The
    // channel does not filter by deck membership or agent type — it leans
    // wholly on the tracker refusing to mint activity, so that has to hold
    // from THIS side too.
    keys.press("pane-1", "l");
    keys.press("shell-pane", "s");
    expect(tracker.getSnapshot().panes.size).toBe(0);
  });

  it("a key pressed before the session is live answers nothing", () => {
    createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    // A hook can beat the spawn promise, so a pane can be `waiting` while
    // its process is still starting — and a write in that window is a
    // no-op, so the keystroke reached no agent and answered nothing.
    kinds.set("pane-1", "starting");
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });

    keys.press("pane-1", "\r");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
  });

  it("stops reading keystrokes after dispose", () => {
    const channel = createAgentStatusChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
      keys.port,
    );
    parkOnApproval();

    channel.dispose();
    keys.press("pane-1", "\r");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
  });
});
