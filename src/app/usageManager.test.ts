import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedUsage } from "../domain/usage";
import {
  getUsageSnapshot,
  registerUsageNormalizer,
  reportUsage,
  resetUsageManager,
  retainUsagePanes,
  setAccountUsage,
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

  it("merges partial pane reports instead of replacing them", () => {
    const model = fake({
      account: null,
      pane: { agent: "fake", model: "m-1", reportedAt: 1 },
    });
    reportUsage("pane-1", { agent: "fake" });
    model();
    const numbers = fake({
      account: null,
      pane: { agent: "fake", context: { usedTokens: 42 }, reportedAt: 2 },
    });
    reportUsage("pane-1", { agent: "fake" });
    numbers();
    expect(getUsageSnapshot().panes.get("pane-1")).toEqual({
      agent: "fake",
      model: "m-1",
      context: { usedTokens: 42 },
      reportedAt: 2,
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

describe("catch-up reports", () => {
  it("never overwrite LIVE data of this run", () => {
    const live = fake(reported(10));
    reportUsage("pane-live", { agent: "fake" });
    live();
    // A freshly-armed pane replays an OLD snapshot stamped with receipt
    // time — without the mark it would outrank the live data above.
    const replay = fake({
      account: { kind: "reported", windows: [], reportedAt: 99, sourcePaneId: "" },
      pane: { agent: "fake", model: "stale", reportedAt: 99 },
    });
    reportUsage("pane-new", { agent: "fake", catchUp: true });
    replay();
    expect(getUsageSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 10,
      sourcePaneId: "pane-live",
    });
    // The NEW pane had no live data of its own — the replay fills that gap.
    expect(getUsageSnapshot().panes.get("pane-new")).toMatchObject({
      model: "stale",
    });
  });

  it("merge complementary replay events — one arm is several partials", () => {
    // The tailer deliberately splits catch-up into context-first partials
    // (codex: turn_context then token_count). Both must land and merge.
    const model = fake({
      account: null,
      pane: { agent: "fake", model: "gpt-x", reportedAt: 1 },
    });
    reportUsage("pane-1", { agent: "fake", catchUp: true });
    model();
    const numbers = fake({
      account: null,
      pane: { agent: "fake", context: { usedPct: 40 }, reportedAt: 2 },
    });
    reportUsage("pane-1", { agent: "fake", catchUp: true });
    numbers();
    expect(getUsageSnapshot().panes.get("pane-1")).toEqual({
      agent: "fake",
      model: "gpt-x",
      context: { usedPct: 40 },
      reportedAt: 2,
    });
  });

  it("beat a hydrated snapshot — replays are fresher than yesterday's cache", () => {
    // Boot hydration is NOT live provenance: a catch-up replay from the
    // actual session file must be allowed to update it.
    setAccountUsage("fake", {
      kind: "reported",
      windows: [],
      reportedAt: 1,
      sourcePaneId: "",
    });
    const replay = fake(reported(50));
    reportUsage("pane-1", { agent: "fake", catchUp: true });
    replay();
    expect(getUsageSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 50,
    });
  });

  it("rank against hydrated state by source time, not replay receipt time", () => {
    // Exact regression: a three-day-old rollout was armed today and its
    // receipt timestamp made 68% beat the genuinely current cached 49%.
    setAccountUsage("fake", {
      kind: "reported",
      windows: [],
      reportedAt: Date.parse("2026-07-19T12:00:00.000Z"),
      sourcePaneId: "",
    });
    const dispose = registerUsageNormalizer("fake", (_payload, at) => reported(at));
    reportUsage(
      "pane-old",
      {
        agent: "fake",
        catchUp: true,
        sourceAt: "2026-07-16T22:13:08.000Z",
      },
      Date.parse("2026-07-19T15:57:00.000Z"),
    );
    dispose();

    expect(getUsageSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: Date.parse("2026-07-19T12:00:00.000Z"),
    });
  });

  it("accept file-mtime milliseconds as the replay fallback", () => {
    const dispose = registerUsageNormalizer("fake", (_payload, at) => reported(at));
    reportUsage("pane-1", { agent: "fake", catchUp: true, sourceAt: 2_000 }, 99_000);
    dispose();
    expect(getUsageSnapshot().accounts.get("fake")).toMatchObject({ reportedAt: 2_000 });
  });

  it("populate an empty store like any first report", () => {
    const dispose = fake(reported(5));
    reportUsage("pane-1", { agent: "fake", catchUp: true });
    dispose();
    expect(getUsageSnapshot().accounts.get("fake")).toBeDefined();
  });
});

describe("setAccountUsage", () => {
  it("applies polled documents freshest-wins alongside pane reports", () => {
    setAccountUsage("kimi", {
      kind: "reported",
      windows: [],
      reportedAt: 10,
      sourcePaneId: "",
    });
    // An older poll result must not downgrade the account.
    setAccountUsage("kimi", {
      kind: "reported",
      windows: [],
      reportedAt: 3,
      sourcePaneId: "",
    });
    expect(getUsageSnapshot().accounts.get("kimi")).toMatchObject({
      reportedAt: 10,
    });
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
