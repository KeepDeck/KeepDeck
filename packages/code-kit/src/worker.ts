/**
 * The highlight worker's entry: `serve` (serve.ts) on the worker's port.
 * Built inline into the plugin's bundle (`?worker&inline` in highlighter.ts),
 * so it carries its own copy of Shiki and needs nothing from the host.
 */
import { serve } from "./serve";

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  serve(event.data, (message) => self.postMessage(message));
});
