import { describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckStore } from "./deckStore";
import { createDeckActions } from "./deckActions";
import { createPaneAttribution } from "./paneAttribution";
import { createUsageManager } from "./usageManager";
import { createUsageSightings } from "./usageSightings";

vi.mock("../ipc/usage", () => ({ readStoreCold: vi.fn(() => Promise.resolve(null)) }));
vi.mock("../ipc/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
import { createUsageMaintenanceLane } from "./usageChannelMaintenance";

describe("usage maintenance", () => {
  it("forgets when it saw the sessions of panes that left the deck, and only theirs", () => {
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
        { id: "pane-2", agentType: "codex" },
      ],
    });
    let clock = 1_000;
    const sightings = createUsageSightings(() => clock);
    sightings.sight("pane-1", "s-1");
    sightings.sight("pane-2", "s-2");
    const lane = createUsageMaintenanceLane({
      deck: store,
      attribution: createPaneAttribution({
        workspaces: () => store.getSnapshot().workspaces,
        secretOf: () => "token-1",
        swapSources: () => [],
      }),
      bindings: { subscribe: () => () => {} },
      declarations: { current: () => new Map(), subscribe: () => () => {} },
      usage: createUsageManager(),
      sightings,
      tailOf: () => undefined,
      companionOf: () => undefined,
    });
    try {
      clock = 2_000;
      deck.closeAgent("ws-1", "pane-2");

      expect(sightings.sight("pane-1", "s-1")).toBe(1_000);
      expect(sightings.sight("pane-2", "s-2")).toBe(2_000);
    } finally {
      lane.dispose();
    }
  });
});
