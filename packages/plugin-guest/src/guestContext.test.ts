import { describe, expect, it } from "vitest";
import { buildGuestContext } from "./context";
import { fakeManifest } from "./fakeHost";
import { GuestRpc } from "./rpc";

/**
 * Direct tests of the guest context builder — the parts worth pinning without
 * standing up the whole channel. Chief among them: an external dock tab MUST be
 * the iframe variant, and the guest must reject a Component synchronously (a
 * plugin author sees the mistake at the `register` call, not as a silent no-op
 * or a broken frame later).
 */

/** A GuestRpc over a port whose `postMessage` is a no-op — the synchronous
 * guard under test fires before anything would be sent. */
function silentRpc(): GuestRpc {
  const port = { postMessage() {}, onmessage: null } as unknown as MessagePort;
  return new GuestRpc(port);
}

describe("buildGuestContext dock tabs", () => {
  it("throws synchronously when a dock tab carries a React Component", () => {
    const { ctx } = buildGuestContext(silentRpc(), fakeManifest());
    expect(() =>
      ctx.ui.registerDockTab({ id: "t", label: "T", Component: () => null }),
    ).toThrow(/iframe/);
  });

  it("accepts the iframe dock-tab variant", () => {
    const { ctx } = buildGuestContext(silentRpc(), fakeManifest());
    const disposable = ctx.ui.registerDockTab({
      id: "t",
      label: "T",
      iframe: "ui/panel.html",
    });
    expect(typeof disposable.dispose).toBe("function");
  });

  it("carries the host-provided manifest through as ctx.manifest", () => {
    const manifest = fakeManifest("dev.custom");
    const { ctx } = buildGuestContext(silentRpc(), manifest);
    expect(ctx.manifest).toBe(manifest);
  });
});
