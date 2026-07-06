import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import { connectPluginGuest } from "./connect";

/**
 * The one line a plugin's `logic.js` calls at module scope:
 *
 *   bootstrapPluginRealm(plugin);
 *
 * The host boots the logic realm by loading the synthesized
 * `__logic__.html` (which loads `logic.js`) and then posting a single
 * message whose transferables carry the realm's end of the RPC
 * `MessagePort`. This helper owns that handshake so plugin authors never
 * touch `window.onmessage`: first message with a port wins, everything
 * else (there should be nothing else) is ignored.
 */
export function bootstrapPluginRealm(plugin: KeepDeckPlugin): void {
  const once = (event: MessageEvent) => {
    const port = event.ports[0];
    if (!port) return;
    window.removeEventListener("message", once);
    connectPluginGuest(port, plugin);
  };
  window.addEventListener("message", once);
}
