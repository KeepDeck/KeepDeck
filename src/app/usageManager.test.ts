import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeClaudeStatusline } from "../../plugins/claude/src/usage";
import type { NormalizedUsage } from "../domain/usage";
import { createUsageManager, type UsageManager } from "./usageManager";

// A fresh instance per test — the factory's whole point: no shared module
// state, no teardown hook.
let usage: UsageManager;
beforeEach(() => {
  usage = createUsageManager();
});

/** A fake agent whose normalizer echoes whatever the payload dictates —
 * the mechanics under test are dispatch, freshest-wins and pruning. */
function fake(result: NormalizedUsage | null) {
  return usage.registerNormalizer("fake", () => result);
}

const reported = (reportedAt: number): NormalizedUsage => ({
  account: { kind: "reported", windows: [], reportedAt, sourcePaneId: "" },
  pane: null,
});

describe("report", () => {
  it("dispatches by payload.agent and records the source pane", () => {
    const dispose = fake({
      account: { kind: "reported", windows: [], reportedAt: 5, sourcePaneId: "" },
      pane: { agent: "fake", reportedAt: 5 },
    });
    usage.report("pane-1", { agent: "fake" });
    const snapshot = usage.getSnapshot();
    expect(snapshot.accounts.get("fake")).toMatchObject({
      kind: "reported",
      sourcePaneId: "pane-1",
    });
    expect(snapshot.panes.get("pane-1")).toMatchObject({ agent: "fake" });
    dispose();
  });

  it("ignores unknown agents and unrecognizable payloads", () => {
    usage.report("pane-1", { agent: "nobody" });
    usage.report("pane-1", "garbage");
    usage.report("pane-1", { noAgent: true });
    expect(usage.getSnapshot().accounts.size).toBe(0);
    expect(usage.getSnapshot().panes.size).toBe(0);
  });

  it("collapses account reports freshest-wins across panes", () => {
    const dispose = fake(reported(10));
    usage.report("pane-new", { agent: "fake" });
    dispose();
    const older = fake(reported(3));
    usage.report("pane-old", { agent: "fake" });
    older();
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 10,
      sourcePaneId: "pane-new",
    });
  });

  it("merges partial pane reports instead of replacing them", () => {
    const model = fake({
      account: null,
      pane: { agent: "fake", model: "m-1", reportedAt: 1 },
    });
    usage.report("pane-1", { agent: "fake" });
    model();
    const numbers = fake({
      account: null,
      pane: { agent: "fake", context: { usedTokens: 42 }, reportedAt: 2 },
    });
    usage.report("pane-1", { agent: "fake" });
    numbers();
    expect(usage.getSnapshot().panes.get("pane-1")).toEqual({
      agent: "fake",
      model: "m-1",
      context: { usedTokens: 42 },
      reportedAt: 2,
    });
  });

  it("keeps the snapshot referentially stable when nothing changes", () => {
    const before = usage.getSnapshot();
    usage.report("pane-1", { agent: "nobody" });
    expect(usage.getSnapshot()).toBe(before);
  });

  it("notifies subscribers once per applied report", () => {
    const dispose = fake(reported(1));
    const listener = vi.fn();
    const unsubscribe = usage.subscribe(listener);
    usage.report("pane-1", { agent: "fake" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    dispose();
  });

  it("ranks live tailed account data by source time instead of delivery time", () => {
    usage.setAccount("fake", {
      kind: "reported",
      windows: [],
      reportedAt: 2_000,
      sourcePaneId: "",
    });
    const dispose = usage.registerNormalizer("fake", (_payload, at) =>
      reported(at),
    );

    // Written before the poll but delivered after it: must not downgrade.
    usage.report(
      "pane-1",
      { agent: "fake", sourceAt: 1_000, sourceMtimeMs: 1_100 },
      3_000,
    );
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 2_000,
    });

    // A genuinely newer source still wins, independently of receipt time.
    usage.report("pane-1", { agent: "fake", sourceAt: 2_500 }, 4_000);
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 2_500,
    });
    dispose();
  });

  it("a stale session's echo (older source mtime) cannot clobber a fresher one", () => {
    // The account-jumping bug: the claude reporter stamps each report with the
    // transcript's mtime (the session's last-turn time). An active pane's turn
    // and an idle pane's frozen refresh echo then race across panes — the echo
    // is DELIVERED later but carries an OLDER capture time, so it must lose.
    const dispose = usage.registerNormalizer("fake", (_payload, at) => reported(at));
    usage.report("pane-active", { agent: "fake", sourceMtimeMs: 10_000 }, 50_000);
    usage.report("pane-idle", { agent: "fake", sourceMtimeMs: 3_000 }, 60_000);
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 10_000,
      sourcePaneId: "pane-active",
    });
    dispose();
  });

  it("ranks the REAL claude account by the reporter's sourceMtimeMs, end to end", () => {
    // The whole chain in one test: a reporter-shaped envelope (verbatim
    // statusline + a sibling sourceMtimeMs) → reportUsage derives the capture
    // time from it → the real normalizeClaudeStatusline stamps the account →
    // freshest ranks by it. The idle 3% echo (older mtime, delivered LATER)
    // must not clobber the active 6% reading.
    const dispose = usage.registerNormalizer("claude", normalizeClaudeStatusline);
    const win = (p: number) => ({
      rate_limits: { five_hour: { used_percentage: p, resets_at: 1_800_000_000 } },
    });
    usage.report(
      "pane-active",
      { agent: "claude", statusline: win(6), sourceMtimeMs: 2_000 },
      9_000,
    );
    usage.report(
      "pane-idle",
      { agent: "claude", statusline: win(3), sourceMtimeMs: 1_000 },
      9_999,
    );
    expect(usage.getSnapshot().accounts.get("claude")).toMatchObject({
      reportedAt: 2_000,
      sourcePaneId: "pane-active",
      windows: [{ usedPct: 6 }],
    });
    dispose();
  });
});

describe("retainPanes", () => {
  it("drops closed panes but keeps account state", () => {
    const dispose = fake({
      account: { kind: "reported", windows: [], reportedAt: 1, sourcePaneId: "" },
      pane: { agent: "fake", reportedAt: 1 },
    });
    usage.report("pane-1", { agent: "fake" });
    usage.report("pane-2", { agent: "fake" });
    dispose();

    usage.retainPanes(new Set(["pane-2"]));
    const snapshot = usage.getSnapshot();
    expect([...snapshot.panes.keys()]).toEqual(["pane-2"]);
    expect(snapshot.accounts.get("fake")).toBeDefined();
  });

  it("is a no-op (no notify) when every pane is still live", () => {
    const dispose = fake({
      account: null,
      pane: { agent: "fake", reportedAt: 1 },
    });
    usage.report("pane-1", { agent: "fake" });
    dispose();
    const listener = vi.fn();
    const unsubscribe = usage.subscribe(listener);
    usage.retainPanes(new Set(["pane-1", "pane-ghost"]));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("clearPane", () => {
  it("starts a pane generation over while preserving account usage", () => {
    const dispose = fake({
      account: { kind: "reported", windows: [], reportedAt: 1, sourcePaneId: "" },
      pane: { agent: "fake", sessionId: "old", reportedAt: 1 },
    });
    usage.report("pane-1", { agent: "fake" });

    usage.clearPane("pane-1");

    expect(usage.getSnapshot().panes.has("pane-1")).toBe(false);
    expect(usage.getSnapshot().accounts.get("fake")).toBeDefined();
    dispose();
  });

  it("resets live provenance so resumed catch-up can seed the pane", () => {
    const live = fake({
      account: null,
      pane: { agent: "fake", sessionId: "old", reportedAt: 1 },
    });
    usage.report("pane-1", { agent: "fake" });
    live();
    usage.clearPane("pane-1");

    const replay = fake({
      account: null,
      pane: { agent: "fake", sessionId: "resumed", reportedAt: 2 },
    });
    usage.report("pane-1", { agent: "fake", catchUp: true });

    expect(usage.getSnapshot().panes.get("pane-1")?.sessionId).toBe("resumed");
    replay();
  });

  it("keeps a new-session report that overtook its binding", () => {
    const dispose = fake({
      account: null,
      pane: { agent: "fake", sessionId: "session-new", reportedAt: 2 },
    });
    usage.report("pane-1", { agent: "fake" });
    const beforeBinding = usage.getSnapshot();

    usage.beginPaneSession("pane-1", "session-new");

    expect(usage.getSnapshot()).toBe(beforeBinding);
    expect(usage.getSnapshot().panes.get("pane-1")?.sessionId).toBe("session-new");
    dispose();
  });
});

describe("catch-up reports", () => {
  it("never overwrite LIVE data of this run", () => {
    const live = fake(reported(10));
    usage.report("pane-live", { agent: "fake" });
    live();
    // A freshly-armed pane replays an OLD snapshot stamped with receipt
    // time — without the mark it would outrank the live data above.
    const replay = fake({
      account: { kind: "reported", windows: [], reportedAt: 99, sourcePaneId: "" },
      pane: { agent: "fake", model: "stale", reportedAt: 99 },
    });
    usage.report("pane-new", { agent: "fake", catchUp: true });
    replay();
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 10,
      sourcePaneId: "pane-live",
    });
    // The NEW pane had no live data of its own — the replay fills that gap.
    expect(usage.getSnapshot().panes.get("pane-new")).toMatchObject({
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
    usage.report("pane-1", { agent: "fake", catchUp: true });
    model();
    const numbers = fake({
      account: null,
      pane: { agent: "fake", context: { usedPct: 40 }, reportedAt: 2 },
    });
    usage.report("pane-1", { agent: "fake", catchUp: true });
    numbers();
    expect(usage.getSnapshot().panes.get("pane-1")).toEqual({
      agent: "fake",
      model: "gpt-x",
      context: { usedPct: 40 },
      reportedAt: 2,
    });
  });

  it("fills live pane gaps from replay without overwriting live fields", () => {
    const live = fake({
      account: null,
      pane: {
        agent: "fake",
        model: "Live display name",
        costUsd: 4,
        reportedAt: 20,
      },
    });
    usage.report("pane-1", { agent: "fake" });
    live();
    const replay = fake({
      account: null,
      pane: {
        agent: "fake",
        model: "stale-raw-id",
        totalTokens: { input: 100, cacheRead: 900 },
        reportedAt: 10,
      },
    });
    usage.report("pane-1", { agent: "fake", catchUp: true });
    replay();

    expect(usage.getSnapshot().panes.get("pane-1")).toEqual({
      agent: "fake",
      model: "Live display name",
      costUsd: 4,
      totalTokens: { input: 100, cacheRead: 900 },
      reportedAt: 20,
    });
  });

  it("beat a hydrated snapshot — replays are fresher than yesterday's cache", () => {
    // Boot hydration is NOT live provenance: a catch-up replay from the
    // actual session file must be allowed to update it.
    usage.setAccount("fake", {
      kind: "reported",
      windows: [],
      reportedAt: 1,
      sourcePaneId: "",
    });
    const replay = fake(reported(50));
    usage.report("pane-1", { agent: "fake", catchUp: true });
    replay();
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 50,
    });
  });

  it("rank against hydrated state by source time, not replay receipt time", () => {
    // Exact regression: a three-day-old rollout was armed today and its
    // receipt timestamp made 68% beat the genuinely current cached 49%.
    usage.setAccount("fake", {
      kind: "reported",
      windows: [],
      reportedAt: Date.parse("2026-07-19T12:00:00.000Z"),
      sourcePaneId: "",
    });
    const dispose = usage.registerNormalizer("fake", (_payload, at) =>
      reported(at),
    );
    usage.report(
      "pane-old",
      {
        agent: "fake",
        catchUp: true,
        sourceAt: "2026-07-16T22:13:08.000Z",
      },
      Date.parse("2026-07-19T15:57:00.000Z"),
    );
    dispose();

    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: Date.parse("2026-07-19T12:00:00.000Z"),
    });
  });

  it("accept file-mtime milliseconds as the replay fallback", () => {
    const dispose = usage.registerNormalizer("fake", (_payload, at) => reported(at));
    usage.report("pane-1", { agent: "fake", catchUp: true, sourceAt: 2_000 }, 99_000);
    dispose();
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 2_000,
    });
  });

  it("uses file mtime when the event timestamp is malformed", () => {
    const dispose = usage.registerNormalizer("fake", (_payload, at) =>
      reported(at),
    );
    usage.report(
      "pane-1",
      {
        agent: "fake",
        catchUp: true,
        sourceAt: "not-an-iso-time",
        sourceMtimeMs: 2_000,
      },
      99_000,
    );
    dispose();
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 2_000,
    });
  });

  it("rejects future provenance instead of poisoning freshest-wins", () => {
    usage.setAccount("fake", {
      kind: "reported",
      windows: [],
      reportedAt: 5_000,
      sourcePaneId: "",
    });
    const dispose = usage.registerNormalizer("fake", (_payload, at) =>
      reported(at),
    );
    usage.report(
      "pane-1",
      {
        agent: "fake",
        catchUp: true,
        sourceAt: "2099-01-01T00:00:00.000Z",
        sourceMtimeMs: 2_000,
      },
      99_000,
    );
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 5_000,
    });

    // With no valid fallback an unknown-age replay can fill an empty store,
    // but epoch time prevents it from outranking any real observation.
    usage = createUsageManager();
    const restore = usage.registerNormalizer("fake", (_payload, at) =>
      reported(at),
    );
    usage.report(
      "pane-1",
      { agent: "fake", catchUp: true, sourceAt: 100_000 },
      99_000,
    );
    expect(usage.getSnapshot().accounts.get("fake")).toMatchObject({
      reportedAt: 0,
    });
    restore();
    dispose();
  });

  it("populate an empty store like any first report", () => {
    const dispose = fake(reported(5));
    usage.report("pane-1", { agent: "fake", catchUp: true });
    dispose();
    expect(usage.getSnapshot().accounts.get("fake")).toBeDefined();
  });
});

describe("setAccount", () => {
  it("applies polled documents freshest-wins alongside pane reports", () => {
    usage.setAccount("kimi", {
      kind: "reported",
      windows: [],
      reportedAt: 10,
      sourcePaneId: "",
    });
    // An older poll result must not downgrade the account.
    usage.setAccount("kimi", {
      kind: "reported",
      windows: [],
      reportedAt: 3,
      sourcePaneId: "",
    });
    expect(usage.getSnapshot().accounts.get("kimi")).toMatchObject({
      reportedAt: 10,
    });
  });
});

describe("registerNormalizer", () => {
  it("unregisters only its own registration", () => {
    const first = usage.registerNormalizer("fake", () => null);
    const second = usage.registerNormalizer("fake", () => reported(9));
    first(); // stale dispose must not evict the replacement
    usage.report("pane-1", { agent: "fake" });
    expect(usage.getSnapshot().accounts.get("fake")).toBeDefined();
    second();
  });
});
