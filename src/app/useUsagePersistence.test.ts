// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeUsageCache } from "../domain/usage";
import {
  getUsageSnapshot,
  resetUsageManager,
  setAccountUsage,
} from "./usageManager";
import {
  USAGE_SAVE_DEBOUNCE_MS,
  useUsagePersistence,
} from "./useUsagePersistence";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  loadUsageCache: vi.fn(),
  saveUsageCache: vi.fn(),
}));
vi.mock("../ipc/usage", () => ({
  loadUsageCache: ipc.loadUsageCache,
  saveUsageCache: ipc.saveUsageCache,
}));

function Probe() {
  useUsagePersistence();
  return null;
}

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

describe("useUsagePersistence", () => {
  let root: Root;

  beforeEach(() => {
    resetUsageManager();
    ipc.loadUsageCache.mockReset().mockResolvedValue(null);
    ipc.saveUsageCache.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetUsageManager();
    vi.useRealTimers();
  });

  it("hydrates the stored snapshot into the store on mount", async () => {
    ipc.loadUsageCache.mockResolvedValue(SNAPSHOT);
    act(() => root.render(createElement(Probe)));
    await act(async () => {});
    expect(getUsageSnapshot().accounts.get("claude")).toMatchObject({
      kind: "reported",
      reportedAt: 1_000,
    });
  });

  it("never downgrades live data that beat the load", async () => {
    let resolveLoad!: (json: string) => void;
    ipc.loadUsageCache.mockImplementation(
      () => new Promise<string>((r) => (resolveLoad = r)),
    );
    act(() => root.render(createElement(Probe)));
    await act(async () => {});
    // A live report lands FIRST, fresher than the snapshot.
    setAccountUsage("claude", {
      kind: "reported",
      windows: [],
      reportedAt: 9_999,
      sourcePaneId: "pane-1",
    });
    await act(async () => {
      resolveLoad(SNAPSHOT);
    });
    expect(getUsageSnapshot().accounts.get("claude")).toMatchObject({
      reportedAt: 9_999,
    });
  });

  it("saves account changes on the debounce, ignoring pane-only churn", async () => {
    vi.useFakeTimers();
    act(() => root.render(createElement(Probe)));
    await act(async () => {});
    setAccountUsage("codex", {
      kind: "reported",
      windows: [],
      reportedAt: 5,
      sourcePaneId: "",
    });
    expect(ipc.saveUsageCache).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_SAVE_DEBOUNCE_MS);
    });
    expect(ipc.saveUsageCache).toHaveBeenCalledTimes(1);
    const saved = ipc.saveUsageCache.mock.calls[0][0] as string;
    expect(saved).toContain("codex");
  });
});
