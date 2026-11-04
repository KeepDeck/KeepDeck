import { describe, expect, it, vi } from "vitest";
import type { PaneUsage } from "@keepdeck/plugin-api";
import type { UsageCaptureContext } from "../domain/usage/history/capture";
import { usageEvent } from "../domain/usage/history/event.testSupport";
import type { UsageRow } from "../domain/usage/history/event";
import type { StoredUsageLedger, UsageRecordEntry } from "../ipc/usageLedger";
import { createUsageHistoryManager, RELOAD_AFTER_APPENDS } from "./usageHistoryManager";

const NOW = 1_800_000_000_000;

const context: UsageCaptureContext = {
  workspaceId: "ws-1",
  workspaceName: "Deck",
  workspaceCwd: "/repo",
  paneId: "pane-1",
  paneName: "agent",
  sessionId: "s-1",
  origin: "fresh",
};

const usage = (input: number): PaneUsage => ({
  agent: "claude",
  sessionId: "s-1",
  model: "Opus",
  totalTokens: { input },
  costUsd: 1,
  byModel: { "claude-opus-5-5": { totalTokens: { input }, calls: 1 } },
  reportedAt: NOW,
  sequence: 7,
});

function harness(stored: StoredUsageLedger = { rows: [], complete: true }) {
  // A fresh answer per load, as the IPC gives: the manager appends in place
  // to the rows it was handed.
  const loadUsageLedger = vi.fn(async () => ({ rows: [...stored.rows], complete: stored.complete }));
  // The rows the core books for each report, in order; past them it books
  // nothing.
  const answers: UsageRow[][] = [];
  const recordUsage = vi.fn(
    async (_entry: UsageRecordEntry): Promise<UsageRow[]> => answers.shift() ?? [],
  );
  const manager = createUsageHistoryManager({ loadUsageLedger, recordUsage });
  return { manager, loadUsageLedger, recordUsage, answers };
}

describe("usageHistoryManager", () => {
  it("loads the core's ledger once and publishes it", async () => {
    const row = usageEvent({ eventId: "bucket-1", count: 4 });
    const { manager, loadUsageLedger } = harness({ rows: [row], complete: true });
    await manager.init();
    await manager.init();
    expect(loadUsageLedger).toHaveBeenCalledTimes(1);
    const snapshot = manager.getSnapshot();
    expect(snapshot).toMatchObject({ ready: true, error: null, complete: true });
    expect(snapshot.ledger.events).toEqual([row]);
  });

  it("is ready but incomplete, with the error, when the load fails", async () => {
    const { manager, loadUsageLedger } = harness();
    loadUsageLedger.mockRejectedValueOnce(new Error("store unreadable"));
    await manager.init();
    expect(manager.getSnapshot()).toMatchObject({ ready: true, complete: false });
    expect(manager.getSnapshot().error).toContain("store unreadable");
  });

  it("is incomplete when the store left history out", async () => {
    const { manager } = harness({ rows: [], complete: false });
    await manager.init();
    expect(manager.getSnapshot().complete).toBe(false);
  });

  it("hands the core the report, the pane's facts and the capture instant", async () => {
    const { manager, recordUsage } = harness();
    await manager.record(usage(100), context, NOW + 5);
    expect(recordUsage).toHaveBeenCalledWith({
      report: {
        agent: "claude",
        model: "Opus",
        totalTokens: { input: 100 },
        costUsd: 1,
        byModel: { "claude-opus-5-5": { totalTokens: { input: 100 }, calls: 1 } },
        reportedAt: NOW,
        sequence: 7,
      },
      context,
      capturedAt: NOW + 5,
    });
  });

  it("appends a booked event in place and mints a new ledger view", async () => {
    const { manager, answers } = harness();
    await manager.init();
    const before = manager.getSnapshot().ledger;
    const row = usageEvent({ eventId: "e-1" });
    answers.push([row]);
    await manager.record(usage(100), context);
    const after = manager.getSnapshot().ledger;
    // The array is the same one — an append never copies the ledger — and
    // the view is what tells a reader it changed.
    expect(after.events).toBe(before.events);
    expect(after).not.toBe(before);
    expect(after.version).toBe(before.version + 1);
    expect(after.events).toEqual([row]);
  });

  it("appends every row one booking adds, after the rows it already held", async () => {
    const held = usageEvent({ eventId: "held", tokens: { input: 5 } });
    const { manager, answers } = harness({ rows: [held], complete: true });
    await manager.init();
    const before = manager.getSnapshot().ledger;
    // A report counting per model: a row per model that moved, and its price.
    const opus = usageEvent({ eventId: "opus", model: "claude-opus-5-5", tokens: { input: 80 } });
    const haiku = usageEvent({ eventId: "haiku", model: "claude-haiku-5", tokens: { input: 9 } });
    const price = usageEvent({ eventId: "price", tokens: {}, costSource: "provider", costUsd: 0.2, calls: 0 });
    answers.push([opus, haiku, price]);
    await manager.record(usage(89), context);
    const after = manager.getSnapshot().ledger;
    expect(after.events).toEqual([held, opus, haiku, price]);
    expect(after.events[0]).toBe(held);
    expect(after.version).toBe(before.version + 1);
  });

  it("changes nothing when the core booked nothing", async () => {
    const { manager } = harness();
    await manager.init();
    const before = manager.getSnapshot();
    await manager.record(usage(100), context);
    expect(manager.getSnapshot()).toBe(before);
  });

  it("books reports one after another, in the order they came", async () => {
    const { manager, recordUsage } = harness();
    const order: number[] = [];
    let release: () => void = () => {};
    recordUsage.mockImplementationOnce(async (entry) => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push(entry.report.totalTokens?.input ?? 0);
      return [];
    });
    recordUsage.mockImplementationOnce(async (entry) => {
      order.push(entry.report.totalTokens?.input ?? 0);
      return [];
    });
    const first = manager.record(usage(1), context);
    const second = manager.record(usage(2), context);
    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("reloads the compacted ledger once it has appended enough events", async () => {
    const { manager, answers, loadUsageLedger } = harness();
    await manager.init();
    for (let index = 0; index < RELOAD_AFTER_APPENDS; index += 1) {
      answers.push([usageEvent({ eventId: `e-${index}` })]);
    }
    for (let index = 0; index < RELOAD_AFTER_APPENDS - 1; index += 1) {
      await manager.record(usage(index), context);
    }
    expect(loadUsageLedger).toHaveBeenCalledTimes(1);
    await manager.record(usage(RELOAD_AFTER_APPENDS), context);
    expect(loadUsageLedger).toHaveBeenCalledTimes(2);
    // The reload's answer stands for everything, the appended rows included.
    expect(manager.getSnapshot().ledger.events).toEqual([]);
  });

  it("counts every appended row toward the reload, not every booking", async () => {
    const { manager, answers, loadUsageLedger } = harness();
    await manager.init();
    const bookings = RELOAD_AFTER_APPENDS / 2;
    for (let index = 0; index < bookings; index += 1) {
      answers.push([usageEvent({ eventId: `a-${index}` }), usageEvent({ eventId: `b-${index}` })]);
    }
    for (let index = 0; index < bookings; index += 1) {
      await manager.record(usage(index), context);
    }
    expect(loadUsageLedger).toHaveBeenCalledTimes(2);
  });
});
