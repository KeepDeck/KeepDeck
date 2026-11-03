import { beforeEach, describe, expect, it, vi } from "vitest";
import { isJsonRecord, type PaneUsage } from "@keepdeck/plugin-api";
import type { UsageCaptureContext } from "../domain/usage/history/capture";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckStore } from "./deckStore";
import { createDeckActions } from "./deckActions";
import { createPaneAttribution } from "./paneAttribution";
import { createUsageManager } from "./usageManager";

const recordPaneUsage = vi.hoisted(() =>
  vi.fn<(usage: PaneUsage, context: UsageCaptureContext) => Promise<void>>(() => Promise.resolve()),
);
vi.mock("./usageHistoryManager", () => ({ recordPaneUsage }));
vi.mock("../ipc/usage", () => ({ readStoreCold: vi.fn(() => Promise.resolve(null)) }));
vi.mock("../ipc/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("./spawnSpecs", () => ({
  peekPaneSpawnSpec: () => undefined,
  spawnPlanInheritsSession: () => false,
  spawnPlanNeedsUsageBaseline: () => false,
}));
import { createUsageMaintenanceLane } from "./usageChannelMaintenance";

const BOUND_AT = "2026-07-25T09:00:00.000Z";

function setup() {
  const store = createDeckStore();
  const deck = createDeckActions(store);
  deck.createWorkspace({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "ws",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [
      { id: "pane-1", agentType: "codex" },
      { id: "pane-2", agentType: "codex", session: { id: "s-2", boundAt: BOUND_AT } },
    ],
  });
  const usage = createUsageManager();
  // What each pane's next report reads as.
  const readings = new Map<string, PaneUsage>();
  usage.registerNormalizer("codex", (payload) => {
    const pane = isJsonRecord(payload) && typeof payload.paneId === "string"
      ? readings.get(payload.paneId)
      : undefined;
    return pane ? { account: null, pane } : null;
  });
  const report = (paneId: string, input: number) => {
    readings.set(paneId, { agent: "codex", totalTokens: { input }, reportedAt: input });
    usage.report(paneId, { agent: "codex", paneId });
  };
  const lane = createUsageMaintenanceLane({
    deck: store,
    attribution: createPaneAttribution({
      workspaces: () => store.getSnapshot().workspaces,
      secretOf: () => "token-1",
      swapSources: () => [],
    }),
    bindings: { subscribe: () => () => {} },
    declarations: { current: () => new Map(), subscribe: () => () => {} },
    usage,
    tailOf: () => undefined,
    companionOf: () => undefined,
  });
  const bookedPanes = () => recordPaneUsage.mock.calls.map(([, context]) => context.paneId);
  return { deck, lane, report, bookedPanes };
}

describe("usage history capture", () => {
  beforeEach(() => recordPaneUsage.mockClear());

  it("books only the pane whose usage changed, and nothing for a report that restates it", () => {
    const { deck, lane, report, bookedPanes } = setup();
    try {
      deck.setPaneSession("ws-1", "pane-1", { id: "s-1", boundAt: BOUND_AT });
      report("pane-1", 100);
      report("pane-2", 40);
      expect(bookedPanes()).toEqual(["pane-1", "pane-2"]);

      report("pane-1", 100);
      expect(bookedPanes()).toEqual(["pane-1", "pane-2"]);

      report("pane-1", 150);
      expect(bookedPanes()).toEqual(["pane-1", "pane-2", "pane-1"]);
    } finally {
      lane.dispose();
    }
  });

  it("books a pane again when its booking failed", async () => {
    const { deck, lane, report, bookedPanes } = setup();
    try {
      deck.setPaneSession("ws-1", "pane-1", { id: "s-1", boundAt: BOUND_AT });
      recordPaneUsage.mockRejectedValueOnce(new Error("store unreadable"));
      report("pane-1", 100);
      await vi.waitFor(() => expect(recordPaneUsage).toHaveBeenCalledTimes(1));
      await Promise.resolve();

      report("pane-2", 40);
      expect(bookedPanes()).toEqual(["pane-1", "pane-1", "pane-2"]);
    } finally {
      lane.dispose();
    }
  });

  it("books a pane that had no session yet once a later capture finds one", () => {
    const { deck, lane, report, bookedPanes } = setup();
    try {
      report("pane-1", 100);
      expect(bookedPanes()).toEqual([]);

      deck.setPaneSession("ws-1", "pane-1", { id: "s-1", boundAt: BOUND_AT });
      report("pane-2", 40);
      expect(bookedPanes()).toEqual(["pane-1", "pane-2"]);
    } finally {
      lane.dispose();
    }
  });
});
