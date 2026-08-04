import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContribution, AgentStatusEvent } from "@keepdeck/plugin-api";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import {
  createAgentStatusTracker,
  type AgentStatusTracker,
} from "./agentStatusTracker";
import {
  createAgentStatusChannel,
  type AgentStatusChannel,
  type SessionLivenessPort,
} from "./agentStatusChannel";
import type { DeckStore } from "./deckStore";
import { createPaneAttribution } from "./paneAttribution";
import { reportPaneKey } from "./paneKeys";

const ipc = vi.hoisted(() => ({
  onAgentStatus: vi.fn(() => Promise.resolve(() => {})),
  peekPaneSpawnSpec: vi.fn(() => ({ token: "tok" })),
}));
vi.mock("../ipc/status", () => ({ onAgentStatus: ipc.onAgentStatus }));
vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: ipc.peekPaneSpawnSpec }));
vi.mock("./ptyManager", () => ({
  paneSessionState: () => ({ kind: "live" }),
}));

const edgeNormalizer = (payload: unknown) =>
  (payload as { edge?: AgentStatusEvent }).edge ?? null;

/** A deck store holding one workspace with the given pane ids. */
/** These cases drive the tracker directly, never the bridge lane, so the
 * channel's attribution is only a constructor argument here — one that
 * admits nothing, so a case that DID start reporting through the lane would
 * fail loudly rather than quietly pass on a permissive fake. The lane's own
 * rule is covered in verifiedPaneReports.test.ts. */
const attribution = createPaneAttribution({
  workspaces: () => [],
  secretOf: () => undefined,
});

const deckWith = (...paneIds: string[]) => {
  const listeners = new Set<() => void>();
  let ids = paneIds;
  return {
    store: {
      getSnapshot: () => ({
        workspaces: [
          {
            id: "ws-1",
            panes: ids.map((id) => ({ id, agentType: "claude" })),
          },
        ],
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as DeckStore,
    setPanes(...next: string[]) {
      ids = next;
      for (const listener of [...listeners]) listener();
    },
  };
};

/** A contribution registry whose agent list can change under the channel. */
const agentsWith = () => {
  const listeners = new Set<() => void>();
  let entries = [
    { entry: { id: "claude", status: { normalize: edgeNormalizer } } },
  ];
  return {
    registry: {
      list: () => entries,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ContributionRegistry<AgentContribution>,
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
  let live: AgentStatusChannel[];

  const exit = (paneId: string) => {
    kinds.set(paneId, "exited");
    for (const listener of [...sessionListeners]) listener();
  };

  /**
   * Build a channel and hold it for teardown. `paneKeys` is a module-level
   * registry, so a channel left running would keep answering keystrokes for
   * the rest of the file — every case disposes, whether it asserts on the
   * key lane or not.
   */
  const startChannel = (
    ...args: Parameters<typeof createAgentStatusChannel>
  ): AgentStatusChannel => {
    const channel = createAgentStatusChannel(...args);
    live.push(channel);
    return channel;
  };

  beforeEach(() => {
    tracker = createAgentStatusTracker();
    sessionListeners = new Set();
    kinds = new Map();
    live = [];
    sessions = {
      subscribe(listener) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      state: (paneId) => ({ kind: kinds.get(paneId) ?? "live" }),
    };
  });

  afterEach(() => {
    for (const channel of live.splice(0)) channel.dispose();
  });

  it("clears a pane's activity the moment its process exits", () => {
    startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
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
    startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
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
    startChannel(
      deckWith("pane-1", "pane-2").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
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
    startChannel(
      deckWith("pane-1").store,
      agents.registry,
      tracker,
      sessions,
      attribution,
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
          status: { normalize: () => ({ kind: "turn-end", at: 200 }) },
        },
      },
    ] as never);
    tracker.report("pane-1", { agent: "claude", edge: null });
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "done",
    });
  });

  it("an agent losing its status voice clears its panes — no frozen lie", () => {
    const deck = deckWith("pane-1");
    const agents = agentsWith();
    startChannel(
      deck.store,
      agents.registry,
      tracker,
      sessions,
      attribution,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);

    // The plugin is DISABLED: claude leaves the contribution list whole.
    // Its process may live on, so no sweep would ever fire — the channel
    // must clear what the agent can no longer resolve.
    agents.replace([] as never);
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
  });

  it("retains only the deck's panes when membership changes", () => {
    const deck = deckWith("pane-1", "pane-2");
    startChannel(
      deck.store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
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
    let handler:
      | ((report: { paneId: string; token: string; payload: unknown }) => void)
      | null = null;
    ipc.onAgentStatus.mockImplementationOnce(((h: never) => {
      handler = h;
      return Promise.resolve(() => {});
    }) as never);
    // The one case that reaches the lane, so it gets the real rule over its
    // own deck rather than the refuse-everything default above.
    const deck = deckWith("pane-1");
    startChannel(
      deck.store,
      agentsWith().registry,
      tracker,
      sessions,
      createPaneAttribution({
        workspaces: () => deck.store.getSnapshot().workspaces,
        secretOf: () => "tok",
      }),
    );
    await Promise.resolve();

    handler!({
      paneId: "pane-1",
      token: "tok",
      payload: { agent: "claude", edge: { kind: "turn-start", at: 100 } },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);

    // A wrong token never reaches the store.
    handler!({
      paneId: "pane-1",
      token: "forged",
      payload: { agent: "claude", edge: { kind: "turn-end", at: 200 } },
    });
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "working",
    });
  });

  it("stops sweeping after dispose", () => {
    const channel = startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
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
    startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
    );
    parkOnApproval();

    reportPaneKey("pane-1", "\r");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "working",
    });
  });

  it("reading the question does not answer it", () => {
    startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
    );
    parkOnApproval();

    // Scrolling back to see what is being asked. Clearing here would replace
    // an honest amber with a "Working" that codex never takes back.
    reportPaneKey("pane-1", "\x1b[A");
    reportPaneKey("pane-1", "\x1b[5~");
    reportPaneKey("pane-1", "\x1bb"); // macOS Alt+Left
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
  });

  it("answers only the pane that was typed into", () => {
    startChannel(
      deckWith("pane-1", "pane-2").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
    );
    parkOnApproval();
    tracker.report("pane-2", {
      agent: "claude",
      edge: { kind: "waiting", at: 100, reason: "permission" },
    });

    reportPaneKey("pane-2", "y");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
    expect(tracker.getSnapshot().panes.get("pane-2")).toMatchObject({
      state: "working",
    });
  });

  it("typing in a pane with nothing to answer starts nothing", () => {
    startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
    );
    // A plain shell, or an agent pane that has reported nothing yet. The
    // channel does not filter by deck membership or agent type — it leans
    // wholly on the tracker refusing to mint activity, so that has to hold
    // from THIS side too.
    reportPaneKey("pane-1", "l");
    reportPaneKey("shell-pane", "s");
    expect(tracker.getSnapshot().panes.size).toBe(0);
  });

  it("stops reading keystrokes after dispose", () => {
    const channel = startChannel(
      deckWith("pane-1").store,
      agentsWith().registry,
      tracker,
      sessions,
      attribution,
    );
    parkOnApproval();

    channel.dispose();
    reportPaneKey("pane-1", "\r");
    expect(tracker.getSnapshot().panes.get("pane-1")).toMatchObject({
      state: "waiting",
    });
  });
});
