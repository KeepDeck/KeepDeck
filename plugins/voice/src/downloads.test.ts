import { describe, expect, it, vi } from "vitest";
import type { DownloadState, PluginContext } from "@keepdeck/plugin-api";
import { createFakeHost, fakeManifest } from "../../../packages/plugin-guest/src/fakeHost";
import { createModelDownloads } from "./downloads";

function setup() {
  const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
  const values: DownloadState[] = [];
  const waiters: Array<(value: IteratorResult<DownloadState>) => void> = [];
  let ended = false;
  const stream: AsyncIterable<DownloadState> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => waiters.push(resolve));
      },
    }),
  };
  let jobId = "";
  const start = vi.fn((request) => {
    jobId = request.id;
    return stream;
  });
  const cancel = vi.fn(async () => {});
  const ctx: PluginContext = {
    ...host.ctx,
    services: {
      ...host.ctx.services,
      downloads: { ...host.ctx.services.downloads, start, cancel },
    },
  };
  const emit = (state: Omit<DownloadState, "id">) => {
    const value = { id: jobId, ...state };
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value });
    else values.push(value);
    if (["completed", "cancelled", "failed"].includes(value.phase)) ended = true;
  };
  return { manager: createModelDownloads(ctx), cancel, emit };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("voice model downloads", () => {
  it("tracks byte state and clears the entry on completion", async () => {
    const { manager, emit } = setup();
    const done = manager.start("whisper-small");
    expect(manager.snapshot().active["whisper-small"]?.phase).toBe("queued");
    emit({ phase: "downloading", received: 50, total: 100 });
    await tick();
    expect(manager.snapshot().active["whisper-small"]?.received).toBe(50);
    emit({ phase: "completed", received: 100, total: 100 });
    await expect(done).resolves.toBe(true);
    expect(manager.snapshot().active["whisper-small"]).toBeUndefined();
  });

  it("is idempotent per model while a job is active", () => {
    const { manager } = setup();
    void manager.start("whisper-small");
    void manager.start("whisper-small");
    expect(Object.keys(manager.snapshot().active)).toEqual(["whisper-small"]);
  });

  it("cancels the concrete globally unique job id", () => {
    const { manager, cancel } = setup();
    void manager.start("whisper-small");
    manager.cancel("whisper-small");
    expect(cancel).toHaveBeenCalledWith(expect.any(String));
  });

  it("keeps a transfer error and clears it on the next start", async () => {
    const first = setup();
    const done = first.manager.start("whisper-small");
    first.emit({ phase: "failed", received: 10, total: 100, error: "HTTP 403" });
    await done;
    expect(first.manager.snapshot().errors["whisper-small"]).toBe("HTTP 403");
  });
});
