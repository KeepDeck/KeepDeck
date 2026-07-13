import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import {
  createFakeHost,
  fakeManifest,
} from "../../../packages/plugin-guest/src/fakeHost";
import { createDownloadManager } from "./downloads";

/** A host whose voice.downloadModel is driveable: the test feeds progress and
 * resolves/rejects on demand. */
function setup() {
  const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
  let emit: ((p: { received: number; total: number | null }) => void) | undefined;
  let settle: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  const cancelDownload = vi.fn(async () => {});
  const ctx: PluginContext = {
    ...host.ctx,
    services: {
      ...host.ctx.services,
      voice: {
        ...host.ctx.services.voice,
        downloadModel: vi.fn((_id, onProgress) => {
          emit = onProgress;
          return new Promise<void>((resolve, reject) => {
            settle = { resolve, reject };
          });
        }),
        cancelDownload,
      },
    },
  };
  const manager = createDownloadManager(ctx);
  return {
    manager,
    cancelDownload,
    emit: (p: { received: number; total: number | null }) => emit?.(p),
    finish: () => settle?.resolve(),
    fail: (e: unknown) => settle?.reject(e),
  };
}

describe("createDownloadManager", () => {
  it("tracks progress and clears the entry on completion", async () => {
    const { manager, emit, finish } = setup();
    const done = manager.start("whisper-small");
    expect(manager.snapshot().active["whisper-small"]).toEqual({ percent: 0 });
    expect(manager.anyActive()).toBe(true);

    emit({ received: 50, total: 100 });
    expect(manager.snapshot().active["whisper-small"]).toEqual({ percent: 50 });

    finish();
    await done;
    expect(manager.snapshot().active["whisper-small"]).toBeUndefined();
    expect(manager.anyActive()).toBe(false);
  });

  it("reports indeterminate progress when the server sent no length", async () => {
    const { manager, emit } = setup();
    void manager.start("m");
    emit({ received: 1024, total: null });
    expect(manager.snapshot().active["m"]).toEqual({ percent: null });
  });

  it("is idempotent — a second start while live is a no-op", () => {
    const { manager } = setup();
    void manager.start("m");
    void manager.start("m");
    expect(Object.keys(manager.snapshot().active)).toEqual(["m"]);
  });

  it("records a real error but treats a cancel as a quiet reset", async () => {
    const { manager, fail, cancelDownload } = setup();
    const done = manager.start("m");
    manager.cancel("m");
    expect(cancelDownload).toHaveBeenCalledWith("m");
    fail(new Error("cancelled"));
    await done;
    expect(manager.snapshot().active["m"]).toBeUndefined();
    expect(manager.snapshot().errors["m"]).toBeUndefined();
  });

  it("keeps a transfer error and clears it on the next start", async () => {
    const s = setup();
    const done = s.manager.start("m");
    s.fail(new Error("HTTP 403"));
    await done;
    expect(s.manager.snapshot().errors["m"]).toBe("HTTP 403");

    void s.manager.start("m");
    expect(s.manager.snapshot().errors["m"]).toBeUndefined();
    expect(s.manager.snapshot().active["m"]).toEqual({ percent: 0 });
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const { manager, emit } = setup();
    const seen: number[] = [];
    const off = manager.subscribe(() =>
      seen.push(Object.keys(manager.snapshot().active).length),
    );
    void manager.start("m");
    emit({ received: 10, total: 100 });
    off();
    emit({ received: 20, total: 100 });
    expect(seen).toEqual([1, 1]);
  });
});
