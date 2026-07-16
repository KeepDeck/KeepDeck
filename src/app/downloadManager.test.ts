import { describe, expect, it, vi } from "vitest";
import type { DownloadRequest, DownloadState } from "@keepdeck/plugin-api";
import { DownloadManager, type DownloadBackend } from "./downloadManager";

const request = (id = "job-1"): DownloadRequest => ({
  id,
  source: { url: "https://example.com/file" },
  target: { kind: "file", path: "test/file" },
});

function setup() {
  let emit: (state: DownloadState) => void = () => {};
  const backend: DownloadBackend = {
    start: vi.fn(async (_request, onState) => {
      emit = onState;
      await new Promise<void>(() => {});
    }),
    cancel: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
  return { manager: new DownloadManager(backend), backend, emit: (s: DownloadState) => emit(s) };
}

describe("DownloadManager", () => {
  it("starts immediately, replays state and fans updates to late readers", async () => {
    const { manager, backend, emit } = setup();
    const stream = manager.start(request());
    expect(backend.start).toHaveBeenCalledOnce();
    const first = stream[Symbol.asyncIterator]();
    expect((await first.next()).value?.phase).toBe("queued");

    emit({ id: "job-1", phase: "downloading", received: 5, total: 10 });
    expect((await first.next()).value?.received).toBe(5);
    const late = stream[Symbol.asyncIterator]();
    expect((await late.next()).value?.received).toBe(5);
  });

  it("uses id as the sole unique key", () => {
    const { manager } = setup();
    manager.start(request());
    expect(() => manager.start(request())).toThrow("download id already used");
  });

  it("cancels every active job through the manager", async () => {
    const { manager, backend } = setup();
    manager.start(request());
    await manager.cancel("job-1");
    expect(backend.cancel).toHaveBeenCalledWith("job-1");
  });

  it("closes readers after a terminal state", async () => {
    const { manager, emit } = setup();
    const iterator = manager.start(request())[Symbol.asyncIterator]();
    await iterator.next();
    emit({ id: "job-1", phase: "completed", received: 10, total: 10 });
    expect((await iterator.next()).value?.phase).toBe("completed");
    expect((await iterator.next()).done).toBe(true);
  });

  it("conflates unread progress to the newest snapshot", async () => {
    const { manager, emit } = setup();
    const iterator = manager.start(request())[Symbol.asyncIterator]();
    await iterator.next();
    emit({ id: "job-1", phase: "downloading", received: 1, total: 10 });
    emit({ id: "job-1", phase: "downloading", received: 7, total: 10 });
    expect((await iterator.next()).value?.received).toBe(7);
  });

  it("drops terminal jobs and delegates historical id rejection to the backend", async () => {
    const backend: DownloadBackend = {
      start: vi.fn(async (item, onState) => {
        onState({
          id: item.id,
          phase: "completed",
          received: 1,
          total: 1,
        });
      }),
      cancel: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    };
    const manager = new DownloadManager(backend);
    manager.start(request("job-0"));
    expect(() => manager.start(request("job-0"))).not.toThrow();
    expect(backend.start).toHaveBeenCalledTimes(2);
    await manager.cancel("job-0");
    expect(backend.cancel).toHaveBeenCalledWith("job-0");
  });

  it("turns a synchronous backend refusal into a terminal stream", async () => {
    const backend: DownloadBackend = {
      start: vi.fn(() => {
        throw new Error("target collision");
      }),
      cancel: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    };
    const iterator = new DownloadManager(backend)
      .start(request())
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { phase: "failed", error: "target collision" },
    });
    expect((await iterator.next()).done).toBe(true);
  });
});
