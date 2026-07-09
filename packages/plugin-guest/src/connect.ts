import type { KeepDeckPlugin, PluginManifest } from "@keepdeck/plugin-api";
import { buildGuestContext } from "./context";
import { describeError } from "./errors";
import type { HostToGuestMessage } from "./protocol";
import { GuestRpc } from "./rpc";

/**
 * The entry point an external plugin's LOGIC bundle calls at startup, once its
 * hidden realm iframe has loaded. It owns the guest side of the handshake:
 *
 *   ready → (host) init(manifest) → build context, run activate → activated / failed
 *
 * After `init` it stands up an RPC-backed `PluginContext`, runs the plugin's
 * `activate` against it, and reports the outcome. From then on it is a router:
 * `result` messages settle pending calls, `event` messages fan out to the
 * context's local subscribers. A throw in `activate` (including the synchronous
 * dock-tab-must-be-an-iframe guard) becomes a `failed` reply, never an uncaught
 * error in the realm.
 *
 * It returns nothing: the bridge lives for as long as the realm does, and the
 * realm's teardown (closing the port) is what ends it.
 */
export function connectPluginGuest(port: MessagePort, plugin: KeepDeckPlugin): void {
  const rpc = new GuestRpc(port);
  // Set once `init` builds the context; until then there is nothing to route an
  // event to (the host only pushes after a subscription, which activate makes).
  let dispatchEvent: ((channel: string, payload: unknown) => void) | null = null;

  async function activate(manifest: PluginManifest): Promise<void> {
    try {
      const built = buildGuestContext(rpc, manifest);
      dispatchEvent = built.dispatchEvent;
      await plugin.activate(built.ctx);
      // A refused registration (undeclared contribution, gate violation)
      // fails the activation — same fail-loud semantics as the built-in tier.
      await built.registrationsSettled();
      port.postMessage({ kind: "activated" });
    } catch (error) {
      port.postMessage({ kind: "failed", error: describeError(error) });
    }
  }

  port.onmessage = (event: MessageEvent) => {
    const message = event.data as HostToGuestMessage;
    switch (message.kind) {
      case "result":
        rpc.settle(message);
        return;
      case "event":
        dispatchEvent?.(message.channel, message.payload);
        return;
      case "init":
        void activate(message.manifest);
        return;
    }
  };

  // Announced last, so the router above is already attached when the host
  // answers with `init`.
  port.postMessage({ kind: "ready" });
}
