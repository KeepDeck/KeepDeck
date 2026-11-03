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
  reportedAt: NOW,
  sequence: 7,
});

function harness(stored: StoredUsageLedger = { rows: [], complete: true }) {
  // A fresh answer per load, as the IPC gives: the manager appends in place
  // to the rows it was handed.
  const loadUsageLedger = vi.fn(async () => ({ rows: [...stored.rows], complete: stored.complete }));
  // The rows the core books, in order; past them it books nothing.
  const answers: UsageRow[] = [];
  const recordUsage = vi.fn(
    async (_entry: UsageRecordEntry): Promise<UsageRow | null> => answers.shift() ?? null,
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
    answers.push(row);
    await manager.record(usage(100), context);
    const after = manager.getSnapshot().ledger;
    // The array is the same one — an append never copies the ledger — and
    // the view is what tells a reader it changed.
    expect(after.events).toBe(before.events);
    expect(after).not.toBe(before);
    expect(after.version).toBe(before.version + 1);
    expect(after.events).toEqual([row]);
  });

  it("appends a call's second half after its first, leaving the first as it was", async () => {
    const half = usageEvent({ eventId: "call", tokens: {}, costSource: "provider", costUsd: 0.2 });
    const { manager, answers } = harness({ rows: [half], complete: true });
    await manager.init();
    const rest = usageEvent({ eventId: "rest", tokens: { input: 80 }, count: 0, calls: 0 });
    answers.push(rest);
    await manager.record(usage(180), context);
    // A reader that already folded the first half folds only the rest.
    const { events } = manager.getSnapshot().ledger;
    expect(events).toEqual([half, rest]);
    expect(events[0]).toBe(half);
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
      return null;
    });
    recordUsage.mockImplementationOnce(async (entry) => {
      order.push(entry.report.totalTokens?.input ?? 0);
      return null;
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
      answers.push(usageEvent({ eventId: `e-${index}` }));
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
});
