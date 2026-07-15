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
 *   from the synthesized `__main__.html` (which loads that bundle), gets a
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
      const channel = new MessageChannel();
      const bridge = createHostBridge(channel.port1, ctx);
      // The whole boot is bounded, not just the post-load handshake: a
      // `kdplugin://` document that never fires load/error (a wedged read, a
      // navigation the sandbox swallows) would otherwise leave `openRealm`
      // pending forever, wedging the plugin's `activating` flag with no
      // escape but disable. One deadline covers open + activate.
      const realm = await withTimeout(
        dom.openRealm(externalPluginUrl(manifest.id, "__main__.html")),
        activationTimeoutMs,
        `logic realm document did not load within ${activationTimeoutMs}ms`,
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

/** The origin of a document served at `url` — `kdplugin://<plugin-id>` for a
 * realm. Composed from the parts rather than read off `URL.origin`, which is
 * defined to return the string `"null"` for a non-special scheme like ours. */
function originOf(url: string): string {
  const { protocol, host } = new URL(url);
  return `${protocol}//${host}`;
}

/** The production realm: a hidden, sandboxed iframe running at the PLUGIN's
 * own `kdplugin://<id>` origin. `allow-same-origin` is deliberate and safe
 * here: the isolation boundary is the ORIGIN (each plugin id is a distinct
 * origin, and all are cross-origin to the host `tauri://localhost`), not
 * opaqueness — the Figma/Logseq model. Without it the document would get an
 * opaque origin, and its own CSP `script-src 'self'` would then refuse to
 * load `/main.js` (self ≠ the scheme origin), so the realm could never boot.
 * The sandbox still withholds top-navigation, forms, popups, etc.; network
 * reach is bounded by the per-plugin CSP `connect-src`. */
export const domRealm: RealmDom = {
  openRealm(url) {
    return new Promise((resolve, reject) => {
      // The host-RPC port is a capability: handing it to `"*"` would offer it
      // to whatever document happens to be in the frame. We know exactly which
      // origin may receive it — the realm we are about to load — so name it.
      const realmOrigin = originOf(url);
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.sandbox.add("allow-scripts");
      frame.sandbox.add("allow-same-origin");
      frame.addEventListener("load", () => {
        resolve({
          post(port) {
            frame.contentWindow?.postMessage("kd-connect", realmOrigin, [port]);
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
