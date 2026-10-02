import { describe, expect, it, vi } from "vitest";
import type { AccountUsage, UsageWindow } from "../domain/usage";
import { normalizeClaudeStatusline } from "../../plugins/claude/src/usage";
import {
  decodeWindowReport,
  encodeWindowReport,
  type WindowReport,
} from "../domain/usage/reportJournal";
import { createUsageManager } from "./usageManager";
import { createWindowReportJournal } from "./windowReportJournal";

import {
  TEST_NOW,
  windowReport,
} from "../domain/usage/reportJournal.testSupport";

const NOW = TEST_NOW;
const MIN = 60_000;

const account = (
  windows: UsageWindow[],
  reportedAt = NOW,
): AccountUsage => ({
  kind: "reported",
  windows,
  reportedAt,
  sourcePaneId: "pane-1",
});

function fakeUsage() {
  let accounts = new Map<string, AccountUsage>();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ accounts }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Map<string, AccountUsage>) {
      accounts = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function build(loaded: string[] = []) {
  const usage = fakeUsage();
  const ipc = {
    loadUsageReports: vi.fn(async () => loaded),
    appendUsageReports: vi.fn(async (_lines: string[]) => {}),
    compactUsageReports: vi.fn(async (_lines: string[]) => {}),
  };
  const journal = createWindowReportJournal({ ipc, usage, now: () => NOW });
  return { journal, ipc, usage };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** This file's records default fresher and fuller than the shared builder
 * — stated as overrides so the divergence is visible, not a fork. */
const stored = (over: Partial<WindowReport> = {}): WindowReport =>
  windowReport({ usedPct: 40, reportedAt: NOW - 20 * MIN, ...over });

describe("windowReportJournal", () => {
  it("captures accepted reports per window, applying the write policy", async () => {
    const { journal, ipc, usage } = build();
    journal.start();
    await settle();

    usage.set(
      new Map([
        [
          "claude",
          account([
            { usedPct: 41, resetsAt: NOW + 155 * MIN, windowMinutes: 300 },
            { usedPct: 12, resetsAt: NOW + 4 * 24 * 60 * MIN, windowMinutes: 10_080 },
          ]),
        ],
      ]),
    );
    await settle();
    expect(ipc.appendUsageReports).toHaveBeenCalledTimes(1);
    expect(ipc.appendUsageReports.mock.calls[0][0]).toHaveLength(2);

    // The same snapshot again — chatter, nothing recorded.
    usage.set(usage.getSnapshot().accounts);
    await settle();
    expect(ipc.appendUsageReports).toHaveBeenCalledTimes(1);

    const snapshot = journal.getSnapshot();
    expect(snapshot.ready).toBe(true);
    expect([...snapshot.byKey.keys()]).toHaveLength(2);
  });

  it("records which pane's claim each point came from, and survives without it", async () => {
    const { ipc, journal, usage } = build();
    journal.start();
    await settle();
    const week = { usedPct: 12, resetsAt: NOW + 4 * 24 * 60 * MIN, windowMinutes: 10_080 };
    usage.set(new Map([["claude", account([week])]]));
    // A claim no pane made (a poll, the restored cache) names none.
    usage.set(
      new Map([["codex", { ...account([week]), sourcePaneId: "" }]]),
    );
    await settle();
    const [claude, codex] = ipc.appendUsageReports.mock.calls
      .flatMap(([lines]) => lines)
      .map((line) => decodeWindowReport(line)!);
    expect(claude).toMatchObject({ agent: "claude", sourcePaneId: "pane-1" });
    expect(codex).not.toHaveProperty("sourcePaneId");

    // Older records carry no source and still decode; a malformed source is
    // dropped without dropping the record. The source is never identity.
    const legacy = JSON.stringify({ ...stored(), sourcePaneId: undefined });
    expect(decodeWindowReport(legacy)).toEqual(stored());
    expect(
      decodeWindowReport(JSON.stringify({ ...stored(), sourcePaneId: 7 })),
    ).toEqual(stored());
  });

  it("never journals an idle claude pane's frozen limits — the sawtooth, end to end", async () => {
    // The real chain: claude normalizer → usage manager's activity gate →
    // this journal. The active pane is witnessed at 69%; the idle pane
    // re-sends its frozen 67% on every refresh, newer-dated each time.
    const usage = createUsageManager();
    usage.registerNormalizer("claude", normalizeClaudeStatusline);
    const ipc = {
      loadUsageReports: vi.fn(async () => [] as string[]),
      appendUsageReports: vi.fn(async (_lines: string[]) => {}),
      compactUsageReports: vi.fn(async (_lines: string[]) => {}),
    };
    const journal = createWindowReportJournal({ ipc, usage, now: () => NOW });
    journal.start();
    await settle();
    const line = (session: string, pct: number, cost: number, apiMs: number) => ({
      agent: "claude",
      statusline: {
        session_id: session,
        cost: { total_cost_usd: cost, total_api_duration_ms: apiMs },
        rate_limits: {
          seven_day: { used_percentage: pct, resets_at: (NOW + 3 * 24 * 60 * MIN) / 1000 },
        },
      },
    });
    usage.report("active", line("a", 68, 1, 1_000), NOW - 20 * MIN);
    usage.report("active", line("a", 69, 2, 2_000), NOW - 15 * MIN);
    for (let index = 0; index < 4; index += 1) {
      usage.report(
        "idle",
        { ...line("b", 67, 0.5, 500), sourceMtimeMs: NOW - (9 - index) * MIN },
        NOW - (10 - index) * MIN,
      );
    }
    await settle();
    const points = ipc.appendUsageReports.mock.calls
      .flatMap(([lines]) => lines)
      .map((line) => decodeWindowReport(line)!);
    expect(points.map((point) => [point.usedPct, point.sourcePaneId])).toEqual([
      [69, "active"],
    ]);
  });

  it("keeps array identity fresh on append — memo consumers see changes", async () => {
    const { journal, usage } = build();
    journal.start();
    await settle();
    const windows = [{ usedPct: 10, resetsAt: NOW + 155 * MIN, windowMinutes: 300 }];
    usage.set(new Map([["claude", account(windows, NOW - MIN)]]));
    const key = [...journal.getSnapshot().byKey.keys()][0];
    const before = journal.getSnapshot().byKey.get(key);
    usage.set(
      new Map([
        ["claude", account([{ ...windows[0], usedPct: 11 }], NOW)],
      ]),
    );
    const after = journal.getSnapshot().byKey.get(key);
    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
  });

  it("journals BOTH duration-less windows of one report under distinct keys", async () => {
    const { journal, ipc, usage } = build();
    journal.start();
    await settle();
    // codex's duration-less pair — the identity tuple alone collides.
    usage.set(
      new Map([
        [
          "codex",
          account([
            { usedPct: 30, resetsAt: NOW + 100 * MIN, windowMinutes: null },
            { usedPct: 88, resetsAt: NOW + 900 * MIN, windowMinutes: null },
          ]),
        ],
      ]),
    );
    await settle();
    expect(ipc.appendUsageReports.mock.calls[0][0]).toHaveLength(2);
    const snapshot = journal.getSnapshot();
    expect([...snapshot.byKey.keys()]).toHaveLength(2);
    const series = [...snapshot.byKey.values()];
    expect(series[0][0].usedPct).toBe(30);
    expect(series[1][0].usedPct).toBe(88);
    expect(series[1][0].ordinal).toBe(1); // travels into the stored record
  });

  it("refuses dead-on-arrival records at the door — no write loop", async () => {
    const { journal, ipc, usage } = build();
    journal.start();
    await settle();
    // A cached account restored 100h later: its 5h window is far beyond
    // retention. Pre-fix this line re-appended on EVERY store emit.
    const aged = new Map([
      [
        "claude",
        account(
          [{ usedPct: 41, resetsAt: NOW - 99 * 60 * MIN, windowMinutes: 300 }],
          NOW - 100 * 60 * MIN,
        ),
      ],
    ]);
    usage.set(aged);
    usage.set(aged);
    usage.set(aged);
    await settle();
    expect(ipc.appendUsageReports).not.toHaveBeenCalled();
    expect(journal.getSnapshot().byKey.size).toBe(0);
  });

  it("revives after dispose instead of playing dead", async () => {
    const { journal, ipc, usage } = build();
    journal.start();
    await settle();
    journal.dispose();
    journal.start();
    await settle();
    usage.set(
      new Map([
        [
          "claude",
          account([{ usedPct: 5, resetsAt: NOW + 155 * MIN, windowMinutes: 300 }]),
        ],
      ]),
    );
    await settle();
    expect(ipc.appendUsageReports).toHaveBeenCalledTimes(1);
  });

  it("loads, sorts, prunes and compacts a damaged journal once", async () => {
    const aged = stored({ reportedAt: NOW - 100 * 60 * MIN }); // beyond 7.5h keep
    const fresh = stored();
    const { journal, ipc } = build([
      encodeWindowReport(fresh),
      "torn{",
      encodeWindowReport(aged),
    ]);
    journal.start();
    await settle();

    const key = [...journal.getSnapshot().byKey.keys()][0];
    expect(journal.getSnapshot().byKey.get(key)).toEqual([fresh]);
    expect(ipc.compactUsageReports).toHaveBeenCalledTimes(1);
    expect(ipc.compactUsageReports.mock.calls[0][0]).toEqual([
      encodeWindowReport(fresh),
    ]);
  });

  it("does not rewrite a healthy journal", async () => {
    const { journal, ipc } = build([encodeWindowReport(stored())]);
    journal.start();
    await settle();
    expect(ipc.compactUsageReports).not.toHaveBeenCalled();
  });

  it("ignores non-reported accounts and goes quiet after dispose", async () => {
    const { journal, ipc, usage } = build();
    journal.start();
    await settle();
    usage.set(
      new Map([
        ["codex", { kind: "unavailable", reason: "api-key", reportedAt: NOW }],
      ]),
    );
    expect(ipc.appendUsageReports).not.toHaveBeenCalled();

    journal.dispose();
    usage.set(
      new Map([
        [
          "claude",
          account([{ usedPct: 5, resetsAt: NOW + 155 * MIN, windowMinutes: 300 }]),
        ],
      ]),
    );
    expect(ipc.appendUsageReports).not.toHaveBeenCalled();
  });

  it("starts empty when the journal is unreadable, instead of never starting", async () => {
    const usage = fakeUsage();
    const journal = createWindowReportJournal({
      ipc: {
        loadUsageReports: async () => {
          throw new Error("io");
        },
        appendUsageReports: async () => {},
        compactUsageReports: async () => {},
      },
      usage,
      now: () => NOW,
    });
    journal.start();
    await settle();
    expect(journal.getSnapshot().ready).toBe(true);
  });
});
