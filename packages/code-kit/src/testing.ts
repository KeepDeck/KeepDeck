/**
 * For tests that want real colors through the real client: a `Worker` that
 * runs the worker's own handler (serve.ts) in-process, on the next task — a
 * test realm has no workers, and without one the client renders plain.
 * Install it before the first highlight; the client spawns on first use.
 */
import { vi } from "vitest";
import { serve } from "./serve";

class InProcessWorker extends EventTarget {
  postMessage(data: unknown): void {
    setTimeout(() => {
      serve(data, (reply) => this.dispatchEvent(new MessageEvent("message", { data: reply })));
    }, 0);
  }
  terminate(): void {}
}

export function installInProcessWorker(): void {
  vi.stubGlobal("Worker", InProcessWorker);
}
