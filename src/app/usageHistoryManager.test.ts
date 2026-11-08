import { describe, expect, it, vi } from "vitest";
import type { UsageCallBatch } from "../domain/usage/history/capture";
import { usageEvent } from "../domain/usage/history/event.testSupport";
import type { UsageRow } from "../domain/usage/history/event";
import type { StoredUsageLedger, UsageBookEntry } from "../ipc/usageLedger";
import { createUsageHistoryManager, RELOAD_AFTER_APPENDS } from "./usageHistoryManager";

const NOW = 1_800_000_000_000;

const batch = (input: number): UsageCallBatch => ({
  agent: "claude",
  sessionId: "s-1",
  firstSeen: NOW - 60_000,
  place: {
    workspaceId: "ws-1",
    workspaceName: "Deck",
    workspaceCwd: "/repo",
    paneId: "pane-1",
    paneName: "agent",
  },
  calls: [
    {
      id: `msg_${input}`,
      at: NOW,
      provider: "anthropic",
      model: "claude-opus-5-5",
      tokens: { input, cacheRead: 0, cacheWrite: 0, output: 1 },
    },
  ],
});

function harness(stored: StoredUsageLedger = { rows: [], complete: true, perModelSince: null }) {
  // A fresh answer per load, as the IPC gives: the manager appends in place
  // to the rows it was handed.
  const loadUsageLedger = vi.fn(async (): Promise<StoredUsageLedger> => ({ ...stored, rows: [...stored.rows] }));
  // The rows the core books for each batch, in order; past them it books
  // nothing.
  const answers: UsageRow[][] = [];
  const bookUsageCalls = vi.fn(
    async (_entry: UsageBookEntry): Promise<UsageRow[]> => answers.shift() ?? [],
  );
  const manager = createUsageHistoryManager({ loadUsageLedger, bookUsageCalls });
  return { manager, loadUsageLedger, bookUsageCalls, answers };
}

describe("usageHistoryManager", () => {
  it("loads the core's ledger once and publishes it", async () => {
    const row = usageEvent({ eventId: "bucket-1", count: 4 });
    const { manager, loadUsageLedger } = harness({ rows: [row], complete: true, perModelSince: null });
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

  it("says when the ledger began booking per model, once a load has told it", async () => {
    const { manager } = harness({ rows: [], complete: true, perModelSince: NOW - 60_000 });
    expect(manager.getSnapshot().perModelSince).toBeNull();
    await manager.init();
    expect(manager.getSnapshot().perModelSince).toBe(NOW - 60_000);
  });

  it("is incomplete when the store left history out", async () => {
    const { manager } = harness({ rows: [], complete: false, perModelSince: null });
    await manager.init();
    expect(manager.getSnapshot().complete).toBe(false);
  });

  it("hands the core the batch and the capture instant", async () => {
    const { manager, bookUsageCalls } = harness();
    await manager.book(batch(100), NOW + 5);
    expect(bookUsageCalls).toHaveBeenCalledWith({ batch: batch(100), capturedAt: NOW + 5 });
  });

  it("appends a booked row in place and mints a new ledger view", async () => {
    const { manager, answers } = harness();
    await manager.init();
    const before = manager.getSnapshot().ledger;
    const row = usageEvent({ eventId: "e-1" });
    answers.push([row]);
    await manager.book(batch(100));
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
    const { manager, answers } = harness({ rows: [held], complete: true, perModelSince: null });
    await manager.init();
    const before = manager.getSnapshot().ledger;
    // A batch whose calls ran on two models: a row per model.
    const opus = usageEvent({ eventId: "opus", model: "claude-opus-5-5", tokens: { input: 80 } });
    const haiku = usageEvent({ eventId: "haiku", model: "claude-haiku-5", tokens: { input: 9 } });
    answers.push([opus, haiku]);
    await manager.book(batch(89));
    const after = manager.getSnapshot().ledger;
    expect(after.events).toEqual([held, opus, haiku]);
    expect(after.events[0]).toBe(held);
    expect(after.version).toBe(before.version + 1);
  });

  it("changes nothing when the core booked nothing", async () => {
    const { manager } = harness();
    await manager.init();
    const before = manager.getSnapshot();
    await manager.book(batch(100));
    expect(manager.getSnapshot()).toBe(before);
  });

  it("books batches one after another, in the order they came", async () => {
    const { manager, bookUsageCalls } = harness();
    const order: number[] = [];
    let release: () => void = () => {};
    const inputOf = (entry: UsageBookEntry) => entry.batch.calls[0]?.tokens.input ?? 0;
    bookUsageCalls.mockImplementationOnce(async (entry) => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push(inputOf(entry));
      return [];
    });
    bookUsageCalls.mockImplementationOnce(async (entry) => {
      order.push(inputOf(entry));
      return [];
    });
    const first = manager.book(batch(1));
    const second = manager.book(batch(2));
    await vi.waitFor(() => expect(bookUsageCalls).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("reloads the compacted ledger once it has appended enough rows", async () => {
    const { manager, answers, loadUsageLedger } = harness();
    await manager.init();
    for (let index = 0; index < RELOAD_AFTER_APPENDS; index += 1) {
      answers.push([usageEvent({ eventId: `e-${index}` })]);
    }
    for (let index = 0; index < RELOAD_AFTER_APPENDS - 1; index += 1) {
      await manager.book(batch(index));
    }
    expect(loadUsageLedger).toHaveBeenCalledTimes(1);
    await manager.book(batch(RELOAD_AFTER_APPENDS));
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
      await manager.book(batch(index));
    }
    expect(loadUsageLedger).toHaveBeenCalledTimes(2);
  });
});
