import { describe, expect, it } from "vitest";
import {
  applyJournalEvent,
  emptyJournal,
  flushJournalTail,
  foldJournal,
  hydrateJournalSlice,
  journalRows,
  withJournalEvent,
  type JournalEvent,
  type JournalRecords,
} from "./sessionLog";

const T0 = "2026-07-19T10:00:00.000Z";
const T1 = "2026-07-19T11:00:00.000Z";
const T2 = "2026-07-19T12:00:00.000Z";

const bound = (
  wsId: string,
  sessionId: string,
  over: Partial<JournalEvent & { record: object }>["record"] = {},
): JournalEvent => ({
  e: "bound",
  v: 1,
  wsId,
  record: {
    agent: "claude",
    sessionId,
    cwd: "/repo",
    boundAt: T0,
    paneId: "pane-1",
    ...over,
  },
});

describe("applyJournalEvent", () => {
  it("bound appends a live record; a re-bind upserts, keeping the frozen title", () => {
    let records: JournalRecords = {};
    records = applyJournalEvent(records, bound("ws-1", "s-1"));
    expect(records["ws-1"]).toHaveLength(1);
    expect(records["ws-1"][0]).toMatchObject({ state: "live", paneId: "pane-1" });

    records = applyJournalEvent(records, {
      e: "sealed",
      v: 1,
      wsId: "ws-1",
      sessionId: "s-1",
      title: "fix the tests",
      at: T1,
    });
    records = applyJournalEvent(
      records,
      bound("ws-1", "s-1", { paneId: "pane-9", boundAt: T2 }),
    );
    expect(records["ws-1"]).toHaveLength(1);
    expect(records["ws-1"][0]).toMatchObject({
      state: "live",
      paneId: "pane-9",
      title: "fix the tests",
      boundAt: T2,
    });
  });

  it("sealed closes with endedAt and freezes the title; unknown session no-ops", () => {
    const start = applyJournalEvent({}, bound("ws-1", "s-1"));
    const sealed = applyJournalEvent(start, {
      e: "sealed",
      v: 1,
      wsId: "ws-1",
      sessionId: "s-1",
      title: "refactor",
      at: T1,
    });
    expect(sealed["ws-1"][0]).toMatchObject({
      state: "closed",
      endedAt: T1,
      title: "refactor",
    });
    expect(
      applyJournalEvent(sealed, {
        e: "sealed",
        v: 1,
        wsId: "ws-1",
        sessionId: "nope",
        at: T2,
      }),
    ).toBe(sealed);
  });

  it("deleted removes the record and drops an emptied workspace key", () => {
    let records = applyJournalEvent({}, bound("ws-1", "s-1"));
    records = applyJournalEvent(records, bound("ws-1", "s-2", { paneId: "pane-2" }));
    const one = applyJournalEvent(records, {
      e: "deleted",
      v: 1,
      wsId: "ws-1",
      sessionId: "s-1",
      at: T1,
    });
    expect(one["ws-1"].map((r) => r.sessionId)).toEqual(["s-2"]);
    const none = applyJournalEvent(one, {
      e: "deleted",
      v: 1,
      wsId: "ws-1",
      sessionId: "s-2",
      at: T1,
    });
    expect("ws-1" in none).toBe(false);
  });

  it("wsDeleted drops the whole key; absent key no-ops with the same ref", () => {
    const records = applyJournalEvent({}, bound("ws-1", "s-1"));
    const gone = applyJournalEvent(records, {
      e: "wsDeleted",
      v: 1,
      wsId: "ws-1",
      at: T1,
    });
    expect(gone).toEqual({});
    expect(
      applyJournalEvent(gone, { e: "wsDeleted", v: 1, wsId: "ws-1", at: T2 }),
    ).toBe(gone);
  });
});

describe("withJournalEvent", () => {
  it("queues the event only when it changed the records", () => {
    const one = withJournalEvent(emptyJournal, bound("ws-1", "s-1"));
    expect(one.tail).toHaveLength(1);
    const noop = withJournalEvent(one, {
      e: "deleted",
      v: 1,
      wsId: "ws-1",
      sessionId: "ghost",
      at: T1,
    });
    expect(noop).toBe(one);
  });
});

describe("foldJournal / flushJournalTail", () => {
  it("folds an event sequence into records", () => {
    const records = foldJournal([
      bound("ws-1", "s-1"),
      { e: "sealed", v: 1, wsId: "ws-1", sessionId: "s-1", at: T1 },
      bound("ws-2", "s-9", { paneId: "pane-3" }),
      { e: "wsDeleted", v: 1, wsId: "ws-2", at: T2 },
    ]);
    expect(Object.keys(records)).toEqual(["ws-1"]);
    expect(records["ws-1"][0]).toMatchObject({ state: "closed", endedAt: T1 });
  });

  it("flush trims exactly the appended prefix; zero is a no-op ref", () => {
    let journal = withJournalEvent(emptyJournal, bound("ws-1", "s-1"));
    journal = withJournalEvent(journal, bound("ws-1", "s-2", { paneId: "p2" }));
    expect(flushJournalTail(journal, 0)).toBe(journal);
    const flushed = flushJournalTail(journal, 1);
    expect(flushed.tail).toHaveLength(1);
    expect(flushed.tail[0]).toMatchObject({ e: "bound" });
    expect(flushed.records).toBe(journal.records);
  });
});

describe("hydrateJournalSlice", () => {
  it("prunes orphan workspaces, demotes live records, and lets this run's records win", () => {
    const loaded: JournalRecords = {
      "ws-1": [
        {
          agent: "claude",
          sessionId: "old",
          cwd: "/repo",
          boundAt: T0,
          state: "live",
          paneId: "pane-1",
        },
        {
          agent: "codex",
          sessionId: "done",
          cwd: "/repo",
          boundAt: T0,
          state: "closed",
          endedAt: T0,
        },
      ],
      "ws-gone": [
        {
          agent: "kimi",
          sessionId: "orphan",
          cwd: "/x",
          boundAt: T0,
          state: "closed",
          endedAt: T0,
        },
      ],
    };
    // A binding landed in this run before the load resolved.
    const current = withJournalEvent(
      emptyJournal,
      bound("ws-1", "old", { paneId: "pane-7", boundAt: T2 }),
    );

    const slice = hydrateJournalSlice(current, loaded, new Set(["ws-1"]), T1);

    expect("ws-gone" in slice.records).toBe(false);
    expect(slice.records["ws-1"].map((r) => r.sessionId).sort()).toEqual([
      "done",
      "old",
    ]);
    // The live loaded record demoted, then this run's binding overlaid it.
    const old = slice.records["ws-1"].find((r) => r.sessionId === "old");
    expect(old).toMatchObject({ state: "live", paneId: "pane-7", boundAt: T2 });
    // Convergence events queued: the orphan prune and the demotion seal
    // (cross-workspace order follows key order — semantically irrelevant).
    expect(slice.tail.map((e) => e.e).sort()).toEqual([
      "bound",
      "sealed",
      "wsDeleted",
    ]);
  });
});

describe("journalRows", () => {
  it("orders newest binding first", () => {
    const records = foldJournal([
      bound("ws-1", "a", { boundAt: T0 }),
      bound("ws-1", "b", { boundAt: T2, paneId: "p2" }),
      bound("ws-1", "c", { boundAt: T1, paneId: "p3" }),
    ]);
    expect(journalRows(records, "ws-1").map((r) => r.sessionId)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(journalRows(records, "absent")).toEqual([]);
  });
});
