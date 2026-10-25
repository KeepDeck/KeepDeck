import { describe, expect, it, vi } from "vitest";
import type { PaneReportEvent } from "./verifiedPaneReports";

vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: () => ({ token: "tok" }) }));
vi.mock("./ptyManager", () => ({ paneSessionState: () => ({ kind: "live" }) }));
vi.mock("../ipc/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("../ipc/companions", () => ({ onCompanionHello: vi.fn() }));

import { deckStoreOf } from "./deckStore.testSupport";
import { createPaneAttribution } from "./paneAttribution";
import { listenPaneCompanions } from "./paneCompanions";

const deck = deckStoreOf([{ id: "pane-1", agentType: "claude" }]);

describe("listenPaneCompanions", () => {
  async function lane() {
    const attribution = createPaneAttribution({
      workspaces: () => deck.getSnapshot().workspaces,
      secretOf: () => "tok",
    });
    attribution.recordBinding("pane-1", "4021");
    let deliver!: (report: PaneReportEvent) => void;
    listenPaneCompanions(deck, attribution, async (handler) => {
      deliver = handler;
      return () => {};
    });
    await Promise.resolve();
    return { attribution, deliver };
  }

  it("records a hello from the pane's own process", async () => {
    const { attribution, deliver } = await lane();
    deliver({ paneId: "pane-1", token: "tok", payload: { agent: "claude", reporter: "4021" } });
    expect(attribution.hasCompanion("pane-1")).toBe(true);
  });

  it("drops a hello that names no process, carries another secret or comes from elsewhere", async () => {
    for (const report of [
      { paneId: "pane-1", token: "tok", payload: { agent: "claude" } },
      { paneId: "pane-1", token: "stolen", payload: { agent: "claude", reporter: "4021" } },
      { paneId: "pane-1", token: "tok", payload: { agent: "claude", reporter: "9999" } },
      { paneId: "pane-1", token: "tok", payload: { agent: "codex", reporter: "4021" } },
    ]) {
      const { attribution, deliver } = await lane();
      deliver(report);
      expect(attribution.hasCompanion("pane-1")).toBe(false);
    }
  });
});
