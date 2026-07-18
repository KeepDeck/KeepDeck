import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedUsage } from "../domain/usage";
import {
  getUsageSnapshot,
  registerUsageNormalizer,
  reportUsage,
  resetUsageManager,
  retainUsagePanes,
  subscribeUsage,
} from "./usageManager";

afterEach(() => resetUsageManager());

/** A fake agent whose normalizer echoes whatever the payload dictates —
 * the mechanics under test are dispatch, freshest-wins and pruning. */
function fake(result: NormalizedUsage | null) {
  return registerUsageNormalizer("fake", () => result);
}

const reported = (reportedAt: number): NormalizedUsage => ({
  account: { kind: "reported", windows: [], reportedAt, sourcePaneId: "" },
  pane: null,
});

describe("reportUsage", () => {
  it("dispatches by payload.agent and records the source pane", () => {
    const dispose = fake({
      account: { kind: "reported", windows: [], reportedAt: 5, sourcePaneId: "" },
      pane: { agent: "fake", reportedAt: 5 },
    });
    reportUsage("pane-1", { agent: "fake" });
    const snapshot = getUsageSnapshot();
    expect(snapshot.accounts.get("fake")).toMatchObject({
      kind: "reported",
      sourcePaneId: "pane-1",
    });
    expect(snapshot.panes.get("pane-1")).toMatchObject({ agent: "fake" });
    dispose();
  });

  it("ignores unknown agents and unrecognizable payloads", () => {
    reportUsage("pane-1", { agent: "nobody" });
    reportUsage("pane-1", "garbage");
    reportUsage("pane-1", { noAgent: true });
    expect(getUsageSnapshot().accounts.size).toBe(0);
    expect(getUsageSnapshot().panes.size).toBe(0);
  });

  it("collapses account reports freshest-wins across panes", () => {
    const dispose = fake(reported(10));
    reportUsage("pane-new", { agent: "fake" });
    dispose();
    const older = fake(reported(3));
    reportUsage("pane-old", { agent: "fake" });
    older();
    expect(getUsageSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 10,
      sourcePaneId: "pane-new",
    });
  });

  it("normalizes real claude payloads through the seeded normalizer", () => {
    reportUsage("pane-1", {
      agent: "claude",
      statusline: {
        rate_limits: {
          five_hour: { used_percentage: 42, resets_at: 1_738_425_600 },
        },
      },
    });
    expect(getUsageSnapshot().accounts.get("claude")).toMatchObject({
      kind: "reported",
      windows: [{ usedPct: 42, windowMinutes: 300 }],
    });
  });

  it("keeps the snapshot referentially stable when nothing changes", () => {
    const before = getUsageSnapshot();
    reportUsage("pane-1", { agent: "nobody" });
    expect(getUsageSnapshot()).toBe(before);
  });

  it("notifies subscribers once per applied report", () => {
    const dispose = fake(reported(1));
    const listener = vi.fn();
    const unsubscribe = subscribeUsage(listener);
    reportUsage("pane-1", { agent: "fake" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    dispose();
  });
});

describe("retainUsagePanes", () => {
  it("drops closed panes but keeps account state", () => {
    const dispose = fake({
      account: { kind: "reported", windows: [], reportedAt: 1, sourcePaneId: "" },
      pane: { agent: "fake", reportedAt: 1 },
    });
    reportUsage("pane-1", { agent: "fake" });
    reportUsage("pane-2", { agent: "fake" });
    dispose();

    retainUsagePanes(new Set(["pane-2"]));
    const snapshot = getUsageSnapshot();
    expect([...snapshot.panes.keys()]).toEqual(["pane-2"]);
    expect(snapshot.accounts.get("fake")).toBeDefined();
  });

  it("is a no-op (no notify) when every pane is still live", () => {
    const dispose = fake({
      account: null,
      pane: { agent: "fake", reportedAt: 1 },
    });
    reportUsage("pane-1", { agent: "fake" });
    dispose();
    const listener = vi.fn();
    const unsubscribe = subscribeUsage(listener);
    retainUsagePanes(new Set(["pane-1", "pane-ghost"]));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("registerUsageNormalizer", () => {
  it("unregisters only its own registration", () => {
    const first = registerUsageNormalizer("fake", () => null);
    const second = registerUsageNormalizer("fake", () => reported(9));
    first(); // stale dispose must not evict the replacement
    reportUsage("pane-1", { agent: "fake" });
    expect(getUsageSnapshot().accounts.get("fake")).toBeDefined();
    second();
  });
});
