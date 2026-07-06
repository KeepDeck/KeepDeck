// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import { bootstrapPluginRealm } from "./bootstrap";

/** The handshake's guest half: the FIRST window message carrying a port
 * connects the plugin; port-less noise before it is ignored. */
describe("bootstrapPluginRealm", () => {
  const plugin = (): KeepDeckPlugin => ({ activate: vi.fn() });

  it("connects on the first message that carries a port, ignoring noise", async () => {
    bootstrapPluginRealm(plugin());
    // Port-less noise must not consume the listener.
    window.dispatchEvent(new MessageEvent("message", { data: "noise" }));

    const channel = new MessageChannel();
    const ready = new Promise((resolve) => {
      channel.port1.onmessage = (e) => resolve(e.data);
    });
    window.dispatchEvent(
      new MessageEvent("message", { ports: [channel.port2] }),
    );
    // connectPluginGuest announces itself with `ready` on the delivered port.
    expect(await ready).toEqual({ kind: "ready" });
  });

  it("hands the port to exactly one connection — later messages are ignored", async () => {
    bootstrapPluginRealm(plugin());
    const first = new MessageChannel();
    const second = new MessageChannel();
    const firstReady = new Promise((resolve) => {
      first.port1.onmessage = (e) => resolve(e.data);
    });
    let secondSpoke = false;
    second.port1.onmessage = () => {
      secondSpoke = true;
    };
    window.dispatchEvent(new MessageEvent("message", { ports: [first.port2] }));
    window.dispatchEvent(new MessageEvent("message", { ports: [second.port2] }));

    expect(await firstReady).toEqual({ kind: "ready" });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondSpoke).toBe(false);
  });
});
