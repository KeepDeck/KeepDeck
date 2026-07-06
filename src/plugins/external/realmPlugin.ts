import type {
  KeepDeckPlugin,
  PluginContext,
  PluginManifest,
} from "@keepdeck/plugin-api";
import { createHostBridge } from "./rpc";
import { externalPluginUrl } from "./url";

/**
 * The DOM-facing primitives the realm adapter drives — injectable so the
 * adapter's orchestration is tested against a REAL guest over a real
 * `MessageChannel` without a browser. The default (`domRealm`, below) is the
 * production implementation: a hidden sandboxed iframe.
 */
export interface RealmDom {
  /** Open the logic realm's document; resolves once it can receive the
   * port. `post` transfers the realm's end of the RPC channel; `close`
   * destroys the realm (its scripts stop, its resources are collected). */
  openRealm(url: string): Promise<{
    post(port: MessagePort): void;
    close(): void;
  }>;
}

/** How long a logic realm gets from port delivery to `activated` before the
 * host declares it hung. Generous: a realm boots a document plus one module
 * script — seconds, not tens of them. */
const ACTIVATION_TIMEOUT_MS = 15_000;

/**
 * Wrap one EXTERNAL plugin as the ordinary `KeepDeckPlugin` the host
 * lifecycle already knows how to run — install/activate/deactivate/restart
 * work unchanged, and everything the plugin registers rides the same
 * cascade cleanup as a built-in:
 *
 * - the manifest's dock tabs register DECLARATIVELY as iframe contributions
 *   (components never cross a realm boundary; the App renders each as a
 *   sandboxed iframe under the plugin's own origin);
 * - when the manifest declares a `logic` bundle, a hidden logic realm boots
 *   from the synthesized `__logic__.html` (which loads that bundle), gets a
 *   `MessagePort`, and speaks the SAME context surface over RPC — actions,
 *   storage, events, capability-gated services;
 * - deactivation disposes the bridge (failing in-flight calls, closing the
 *   realm's PTY handles) and destroys the realm.
 *
 * A realm that neither activates nor fails within the timeout is FAILED
 * loudly — a hung plugin must surface in Settings → Plugins, not spin
 * forever behind a silent promise.
 */
export function makeExternalPlugin(
  manifest: PluginManifest,
  dom: RealmDom = domRealm,
  activationTimeoutMs = ACTIVATION_TIMEOUT_MS,
): KeepDeckPlugin {
  let live: { close(): void; disposeBridge(): void } | null = null;

  return {
    async activate(ctx: PluginContext): Promise<void> {
      for (const tab of manifest.contributes.dockTabs ?? []) {
        ctx.ui.registerDockTab({
          id: tab.id,
          label: tab.label,
          iframe: `${tab.id}.html`,
        });
      }
      if (manifest.logic === undefined) return;

      const channel = new MessageChannel();
      const bridge = createHostBridge(channel.port1, ctx);
      const realm = await dom.openRealm(
        externalPluginUrl(manifest.id, "__logic__.html"),
      );
      try {
        realm.post(channel.port2);
        await withTimeout(
          bridge.activated,
          activationTimeoutMs,
          `logic realm did not activate within ${activationTimeoutMs}ms`,
        );
      } catch (error) {
        // A failed boot must not leave a zombie realm; the host's failure
        // path (disposeAll) reclaims the declarative tabs registered above.
        bridge.dispose();
        realm.close();
        throw error;
      }
      live = { close: realm.close, disposeBridge: bridge.dispose };
    },

    deactivate(): void {
      live?.disposeBridge();
      live?.close();
      live = null;
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  reason: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The production realm: a hidden, sandboxed iframe. `allow-scripts` only —
 * no same-origin powers, no forms, no popups; the document's reach is its
 * own origin (per-plugin CSP included) plus the delivered MessagePort. */
export const domRealm: RealmDom = {
  openRealm(url) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.sandbox.add("allow-scripts");
      frame.addEventListener("load", () => {
        resolve({
          post(port) {
            // Opaque origin (sandbox without allow-same-origin) → "*" is the
            // only addressable target; the payload is just the port itself.
            frame.contentWindow?.postMessage("kd-connect", "*", [port]);
          },
          close() {
            frame.remove();
          },
        });
      });
      frame.addEventListener("error", () => {
        frame.remove();
        reject(new Error("logic realm document failed to load"));
      });
      frame.src = url;
      document.body.appendChild(frame);
    });
  },
};
