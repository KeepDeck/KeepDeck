import type { PluginContext } from "@keepdeck/plugin-api";
import { describeError } from "../../host/errors";
import { createHostDispatch } from "./hostDispatch";
import type { GuestToHostMessage } from "./protocol";

/**
 * The host end of the external tier's RPC bridge. Given a `MessagePort` to one
 * plugin's realm and the REAL `PluginContext` the host built for that plugin,
 * it speaks the same context surface across the wire that the built-in tier
 * calls in-process:
 *
 * - a guest `ready` earns the manifest (`init`);
 * - a guest `call` is dispatched onto the context and answered with a `result`
 *   — `ok:true` with the value, or `ok:false` with a message. A plugin can never
 *   crash the host: an unknown path or a throwing member is a failed result,
 *   not an exception that escapes.
 * - `activated` / `failed` settle the returned promise so the host knows whether
 *   the plugin came up.
 *
 * `dispose` is the realm's death certificate. It stops accepting messages, fails
 * every call still in flight (their guest-side promises would otherwise hang
 * forever), and hands off to the dispatch to close the realm's sessions, drop
 * its subscriptions, and retire its registrations — nothing the dead realm held
 * outlives it.
 */
export interface HostBridge {
  dispose(): void;
  /** Resolves when the guest reports `activated`, rejects on `failed`. */
  activated: Promise<void>;
}

export function createHostBridge(
  port: MessagePort,
  ctx: PluginContext,
): HostBridge {
  const push = (channel: string, payload: unknown): void => {
    if (disposed) return;
    port.postMessage({ kind: "event", channel, payload });
  };
  const dispatch = createHostDispatch(ctx, push);

  // Ids of calls the dispatch is still working on. Kept so `dispose` can fail
  // them (a disposed bridge will never post their real result).
  const inFlight = new Set<number>();
  let disposed = false;
  // A guest gets exactly one `init` — a second `ready` (a buggy or hostile
  // realm re-driving its own activation) is ignored, so it can't build N
  // contexts and inflate the host's registries with duplicate contributions.
  let inited = false;

  let settleActivated: (result: PromiseSettledResult<void>) => void = () => {};
  const activated = new Promise<void>((resolve, reject) => {
    settleActivated = (result) =>
      result.status === "fulfilled" ? resolve() : reject(result.reason);
  });

  async function handleCall(id: number, path: string, args: unknown[]): Promise<void> {
    inFlight.add(id);
    try {
      const value = await dispatch.call(path, args);
      if (disposed || !inFlight.delete(id)) return;
      port.postMessage({ kind: "result", id, ok: true, value });
    } catch (error) {
      if (disposed || !inFlight.delete(id)) return;
      port.postMessage({ kind: "result", id, ok: false, error: describeError(error) });
    }
  }

  port.onmessage = (event: MessageEvent) => {
    if (disposed) return;
    const message = event.data as GuestToHostMessage;
    switch (message.kind) {
      case "ready":
        // The guest is up; hand it the manifest it activates against — once.
        if (inited) return;
        inited = true;
        port.postMessage({ kind: "init", manifest: ctx.manifest });
        return;
      case "call":
        void handleCall(message.id, message.path, message.args);
        return;
      case "activated":
        settleActivated({ status: "fulfilled", value: undefined });
        return;
      case "failed":
        settleActivated({ status: "rejected", reason: new Error(message.error) });
        return;
    }
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      // Fail every in-flight call so the guest's awaiting promises reject
      // instead of hanging on a reply that will never come.
      for (const id of inFlight) {
        port.postMessage({ kind: "result", id, ok: false, error: "plugin bridge disposed" });
      }
      inFlight.clear();
      dispatch.dispose();
      // Detach only — the transport (the iframe's port) is owned by whoever
      // created it, and its teardown closes the channel.
      port.onmessage = null;
    },
    activated,
  };
}
