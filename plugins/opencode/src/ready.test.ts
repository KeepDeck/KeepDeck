import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDeck } from "../../../scripts/reporterHarness";
import { normalizeOpencodeStatus, READY_EVENT } from "./status";

// Resource JS — shipped to, and loaded by, the user's opencode process; loaded
// fresh per case, as a new pane's process would load it (the wire is one
// object per module instance).
let resource: typeof import("../resources/keepdeck-plugin/ready.js");
let drained: () => Promise<void>;

describe("the plugin saying its agent is at its prompt", () => {
  let deck: Awaited<ReturnType<typeof startDeck>>;

  beforeEach(async () => {
    vi.resetModules();
    resource = await import("../resources/keepdeck-plugin/ready.js");
    ({ drained } = await import("../resources/keepdeck-plugin/keepdeck-bridge.js"));
    deck = await startDeck();
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 2, dir: "/unused", pane: "pane-3", token: "tok", url: deck.url });
  });

  afterEach(async () => {
    delete process.env.KEEPDECK_BRIDGE;
    await deck.close();
  });

  const posted = async () => {
    await drained();
    await deck.idle();
    return deck.envelopes;
  };

  it("states it once per start, on the status lane, and the deck reads it as ready", async () => {
    expect(resource.announceReady()).toEqual({});
    const envelopes = await posted();
    expect(envelopes).toHaveLength(1);
    const [envelope] = envelopes;
    expect(envelope).toMatchObject({ type: "agent.status", paneId: "pane-3", token: "tok" });
    expect(normalizeOpencodeStatus(envelope.payload, 5)).toEqual({ kind: "ready", at: 5 });
  });

  it("is named the same on both sides of the process boundary", () => {
    expect(resource.READY_EVENT).toBe(READY_EVENT);
  });

  it("says nothing outside a KeepDeck pane", async () => {
    delete process.env.KEEPDECK_BRIDGE;
    expect(resource.announceReady()).toEqual({});
    expect(await posted()).toEqual([]);
  });
});
