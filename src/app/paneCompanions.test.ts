import { describe, expect, it, vi } from "vitest";
import type { PaneReportEvent } from "./verifiedPaneReports";

vi.mock("./spawnSpecs", () => ({ peekPaneSpawnSpec: () => ({ token: "tok" }) }));
vi.mock("./ptyManager", () => ({ paneSessionState: () => ({ kind: "live" }) }));
vi.mock("../ipc/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("../ipc/companions", () => ({ onCompanionHello: vi.fn(), onCompanionDeclined: vi.fn() }));

import { deckStoreOf } from "./deckStore.testSupport";
import { createPaneAttribution } from "./paneAttribution";
import { listenCompanionDeclines, listenPaneCompanions } from "./paneCompanions";

const deck = deckStoreOf([{ id: "pane-1", agentType: "claude" }]);

describe("listenPaneCompanions", () => {
  async function lane() {
    const attribution = createPaneAttribution({
      workspaces: () => deck.getSnapshot().workspaces,
      secretOf: () => "tok",
      swapSources: () => [],
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

describe("listenCompanionDeclines", () => {
  async function lane() {
    const attribution = createPaneAttribution({
      workspaces: () => deck.getSnapshot().workspaces,
      secretOf: () => "tok",
      swapSources: () => [],
    });
    attribution.recordBinding("pane-1", "4021");
    const declined: [string, string, boolean][] = [];
    let deliver!: (report: PaneReportEvent) => void;
    listenCompanionDeclines(deck, attribution, (paneId, wake) => declined.push([paneId, wake.reason, wake.draft]), async (handler) => {
      deliver = handler;
      return () => {};
    });
    await Promise.resolve();
    return { declined, deliver };
  }

  it("hands on a decline from the pane's own process, its reason one clean short line", async () => {
    const { declined, deliver } = await lane();
    const payload = (reason: unknown) => ({ agent: "claude", reporter: "4021", reason, draft: false });
    deliver({ paneId: "pane-1", token: "tok", payload: payload("the session was stopped") });
    // The pane's process wrote it: no line breaks or bidi tricks reach the
    // log, and nothing longer than a reason.
    deliver({ paneId: "pane-1", token: "tok", payload: payload("one\nline‮") });
    deliver({ paneId: "pane-1", token: "tok", payload: payload("x".repeat(500)) });
    deliver({ paneId: "pane-1", token: "tok", payload: payload(7) });
    expect(declined).toEqual([
      ["pane-1", "the session was stopped", false],
      ["pane-1", "one line", false],
      ["pane-1", "x".repeat(200), false],
      ["pane-1", "no reason given", false],
    ]);
  });

  it("takes the composer for empty only when the companion says so in as many words", async () => {
    // A typed line sends whatever the composer holds; a report that does not
    // say "empty" plainly must not be the thing that sends a draft.
    const { declined, deliver } = await lane();
    for (const draft of [true, undefined, "false", 0, null]) {
      deliver({ paneId: "pane-1", token: "tok", payload: { agent: "claude", reporter: "4021", reason: "r", draft } });
    }
    expect(declined.map(([, , draft]) => draft)).toEqual([true, true, true, true, true]);
  });

  it("drops a decline that carries another secret or comes from elsewhere", async () => {
    for (const report of [
      { paneId: "pane-1", token: "stolen", payload: { agent: "claude", reporter: "4021", reason: "r" } },
      { paneId: "pane-1", token: "tok", payload: { agent: "claude", reporter: "9999", reason: "r" } },
      { paneId: "pane-1", token: "tok", payload: { agent: "codex", reporter: "4021", reason: "r" } },
      { paneId: "pane-9", token: "tok", payload: { agent: "claude", reporter: "4021", reason: "r" } },
    ]) {
      const { declined, deliver } = await lane();
      deliver(report);
      expect(declined).toEqual([]);
    }
  });
});
