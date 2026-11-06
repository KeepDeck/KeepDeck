import { describe, expect, it, vi } from "vitest";

// The 1.x entry's wiring alone: the components are stood in for, so starting
// the entry starts nothing real (no wire, no watchers). The 2.x entry's is
// covered end to end in opencodeV2.test.ts.
const started = vi.hoisted(() => ({ ready: vi.fn(() => ({})) }));
vi.mock("../resources/keepdeck-plugin/ready.js", () => ({ announceReady: started.ready }));
vi.mock("../resources/keepdeck-plugin/session-reporter.js", () => ({ startReporter: () => ({}) }));
vi.mock("../resources/keepdeck-plugin/mail-courier.js", () => ({ startCourier: () => ({}) }));
vi.mock("../resources/keepdeck-plugin/follower.js", () => ({ follower: () => ({ start: () => {} }) }));

describe("the 1.x plugin entry", () => {
  it("says the agent is at its prompt as it starts", async () => {
    const { default: plugin } = await import("../resources/keepdeck-plugin/index.js");
    await plugin.server({});
    expect(started.ready).toHaveBeenCalledOnce();
  });
});
