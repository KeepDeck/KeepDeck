import { describe, expect, it, vi } from "vitest";
import { createMailWake } from "./wakeChannel";

const harness = (channel: "terminal" | "bridge" | undefined) => {
  const throughTerminal = vi.fn(() => true);
  const throughBridge = vi.fn();
  return {
    throughTerminal,
    throughBridge,
    wake: createMailWake({
      channelOf: () => channel,
      throughTerminal,
      throughBridge,
    }),
  };
};

describe("createMailWake", () => {
  it("types into a pane whose agent says nothing about it", () => {
    // The floor every CLI meets. An agent that declares no channel is not
    // opting out of being woken — it is an agent whose reporter only runs
    // when its CLI runs it, which is every hook CLI there is.
    const h = harness(undefined);
    expect(h.wake("pane-1")).toBe(true);
    expect(h.throughTerminal).toHaveBeenCalledWith("pane-1");
    expect(h.throughBridge).not.toHaveBeenCalled();
  });

  it("passes the terminal's retry through instead of claiming a wake", () => {
    // False means no live input channel THIS instant. Swallowing it would
    // let the owner record a wake that never happened and then sit out a
    // whole hookWait before trying again.
    const throughTerminal = vi.fn(() => false);
    const wake = createMailWake({
      channelOf: () => "terminal",
      throughTerminal,
      throughBridge: vi.fn(),
    });
    expect(wake("pane-1")).toBe(false);
  });

  it("rings the doorbell for a bridge agent and never types at it", () => {
    // The whole point: an agent whose reporter lives inside its process is
    // never sent words through the terminal — not even a nudge.
    const h = harness("bridge");
    expect(h.wake("pane-1")).toBe(true);
    expect(h.throughBridge).toHaveBeenCalledWith("pane-1");
    expect(h.throughTerminal).not.toHaveBeenCalled();
  });

  it("follows a pane that changed agents between two wakes", () => {
    // Read per call, never cached: a restart can put another CLI in this
    // pane, and a remembered channel would keep typing at an agent that
    // stopped reading its terminal (or stop typing at one that needs it).
    const throughTerminal = vi.fn(() => true);
    const throughBridge = vi.fn();
    let channel: "terminal" | "bridge" = "bridge";
    const wake = createMailWake({
      channelOf: () => channel,
      throughTerminal,
      throughBridge,
    });
    wake("pane-1");
    channel = "terminal";
    wake("pane-1");
    expect(throughBridge).toHaveBeenCalledTimes(1);
    expect(throughTerminal).toHaveBeenCalledTimes(1);
  });
});
