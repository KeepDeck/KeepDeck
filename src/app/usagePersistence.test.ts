import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeUsageCache } from "../domain/usage";
import { createUsageManager, type UsageManager } from "./usageManager";
import {
  initUsagePersistence,
  USAGE_SAVE_DEBOUNCE_MS,
} from "./usagePersistence";

const ipc = vi.hoisted(() => ({
  loadUsageCache: vi.fn(),
  saveUsageCache: vi.fn(),
}));
vi.mock("../ipc/usage", () => ({
  loadUsageCache: ipc.loadUsageCache,
  saveUsageCache: ipc.saveUsageCache,
}));

const SNAPSHOT = serializeUsageCache(
  new Map([
    [
      "claude",
      {
        kind: "reported" as const,
        windows: [{ usedPct: 42, resetsAt: null, windowMinutes: 300 }],
        reportedAt: 1_000,
        sourcePaneId: "",
      },
    ],
  ]),
);

/** Let queued promise callbacks run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("initUsagePersistence", () => {
  let dispose: (() => void) | null = null;
  let usage: UsageManager;

  beforeEach(() => {
    usage = createUsageManager();
    ipc.loadUsageCache.mockReset().mockResolvedValue(null);
    ipc.saveUsageCache.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.useRealTimers();
  });

  it("hydrates the stored snapshot into the store", async () => {
    ipc.loadUsageCache.mockResolvedValue(SNAPSHOT);
    dispose = initUsagePersistence(usage);
    await settle();
    expect(usage.getSnapshot().accounts.get("claude")).toMatchObject({
      kind: "reported",
      reportedAt: 1_000,
    });
  });

  it("never downgrades live data that beat the load, and does not echo-save the boot hydration", async () => {
    let resolveLoad!: (json: string) => void;
    ipc.loadUsageCache.mockImplementation(
      () => new Promise<string>((r) => (resolveLoad = r)),
    );
    dispose = initUsagePersistence(usage);
    // A live report lands FIRST, fresher than the snapshot.
    usage.setAccount("claude", {
      kind: "reported",
      windows: [],
      reportedAt: 9_999,
      sourcePaneId: "pane-1",
    });
    resolveLoad(SNAPSHOT);
    await settle();
    expect(usage.getSnapshot().accounts.get("claude")).toMatchObject({
      reportedAt: 9_999,
    });
  });

  it("does not write the cache back at itself on a quiet boot", async () => {
    vi.useFakeTimers();
    ipc.loadUsageCache.mockResolvedValue(SNAPSHOT);
    dispose = initUsagePersistence(usage);
    await vi.advanceTimersByTimeAsync(0); // let the load land
    await vi.advanceTimersByTimeAsync(USAGE_SAVE_DEBOUNCE_MS * 2);
    expect(ipc.saveUsageCache).not.toHaveBeenCalled();
  });

  it("saves account changes on the debounce", async () => {
    vi.useFakeTimers();
    dispose = initUsagePersistence(usage);
    await vi.advanceTimersByTimeAsync(0);
    usage.setAccount("codex", {
      kind: "reported",
      windows: [],
      reportedAt: 5,
      sourcePaneId: "",
    });
    expect(ipc.saveUsageCache).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(USAGE_SAVE_DEBOUNCE_MS);
    expect(ipc.saveUsageCache).toHaveBeenCalledTimes(1);
    expect(ipc.saveUsageCache.mock.calls[0][0] as string).toContain("codex");
  });
});
