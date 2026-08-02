import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContribution, AgentStatusEvent } from "@keepdeck/plugin-api";
import type { ContributionRegistry } from "../plugins/registries/contributions";
import {
  createAgentStatusTracker,
  type AgentStatusTracker,
} from "./agentStatusTracker";
import {
  createAgentStatusChannel,
  type SessionLivenessPort,
} from "./agentStatusChannel";
import type { DeckStore } from "./deckStore";

vi.mock("../ipc/status", () => ({
  onAgentStatus: vi.fn(() => Promise.resolve(() => {})),
}));

const edgeNormalizer = (payload: unknown) =>
  (payload as { edge?: AgentStatusEvent }).edge ?? null;

/** A deck store holding one workspace with the given pane ids. */
const deckWith = (...paneIds: string[]) =>
  ({
    getSnapshot: () => ({
      workspaces: [{ id: "ws-1", panes: paneIds.map((id) => ({ id })) }],
    }),
    subscribe: () => () => {},
  }) as unknown as DeckStore;

/** A contribution registry with one status-declaring agent. */
const agentsWith = () =>
  ({
    list: () => [
      {
        entry: { id: "claude", status: { normalize: edgeNormalizer } },
      },
    ],
    subscribe: () => () => {},
  }) as unknown as ContributionRegistry<AgentContribution>;

describe("createAgentStatusChannel — process-death sweep", () => {
  let tracker: AgentStatusTracker;
  let sessionListeners: Set<() => void>;
  let kinds: Map<string, string>;
  let sessions: SessionLivenessPort;

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
  });

  it("clears a pane's activity the moment its process exits", () => {
    createAgentStatusChannel(deckWith("pane-1"), agentsWith(), tracker, sessions);
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);

    exit("pane-1");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
  });

  it("only dead panes are swept — live neighbours keep their activity", () => {
    createAgentStatusChannel(
      deckWith("pane-1", "pane-2"),
      agentsWith(),
      tracker,
      sessions,
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

  it("stops sweeping after dispose", () => {
    const channel = createAgentStatusChannel(
      deckWith("pane-1"),
      agentsWith(),
      tracker,
      sessions,
    );
    tracker.report("pane-1", {
      agent: "claude",
      edge: { kind: "turn-start", at: 100 },
    });
    channel.dispose();
    exit("pane-1");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(true);
  });
});
