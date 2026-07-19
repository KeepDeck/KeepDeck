import { describe, expect, it } from "vitest";
import {
  decodeJournalLines,
  encodeJournalEvent,
  shouldCompactJournal,
} from "./persist";
import {
  foldJournal,
  snapshotJournal,
  type JournalEvent,
  type JournalRecords,
} from "./sessionLog";

const T = "2026-07-19T12:00:00.000Z";

const EVENTS: JournalEvent[] = [
  {
    e: "bound",
    v: 1,
    wsId: "ws-1",
    record: {
      agent: "codex",
      sessionId: "s-1",
      cwd: "/repo",
      branch: "kd/x/1",
      yolo: true,
      transcriptPath: "/t/s-1.jsonl",
      boundAt: T,
      paneId: "pane-1",
    },
  },
  { e: "sealed", v: 1, wsId: "ws-1", sessionId: "s-1", title: "auth bug", at: T },
  { e: "deleted", v: 1, wsId: "ws-1", sessionId: "s-1", at: T },
  { e: "wsDeleted", v: 1, wsId: "ws-1", at: T },
  {
    e: "record",
    v: 1,
    wsId: "ws-2",
    record: {
      agent: "kimi",
      sessionId: "s-9",
      cwd: "/x",
      boundAt: T,
      state: "closed",
      endedAt: T,
    },
  },
];

describe("journal line codec", () => {
  it("round-trips every event kind", () => {
    const lines = EVENTS.map(encodeJournalEvent);
    const decoded = decodeJournalLines(lines);
    expect(decoded.events).toEqual(EVENTS);
    expect(decoded.garbage).toBe(0);
    expect(decoded.foreign).toBe(0);
  });

  it("counts torn/invalid lines as garbage and keeps folding the rest", () => {
    const lines = [
      encodeJournalEvent(EVENTS[0]),
      '{"e":"bound","v":1',
      '{"e":"sealed","v":1,"wsId":"ws-1"}',
      "[]",
    ];
    const decoded = decodeJournalLines(lines);
    expect(decoded.events).toEqual([EVENTS[0]]);
    expect(decoded.garbage).toBe(3);
    expect(decoded.foreign).toBe(0);
  });

  it("classifies a newer build's lines as foreign, not garbage", () => {
    const decoded = decodeJournalLines([
      '{"e":"renamed","v":1,"wsId":"ws-1","at":"t"}',
      '{"e":"sealed","v":2,"wsId":"ws-1","sessionId":"s","at":"t","extra":1}',
    ]);
    expect(decoded.events).toEqual([]);
    expect(decoded.garbage).toBe(0);
    expect(decoded.foreign).toBe(2);
  });

  it("a compaction snapshot folds back to exactly the records it captured", () => {
    const records: JournalRecords = {
      "ws-1": [
        {
          agent: "claude",
          sessionId: "live-1",
          cwd: "/repo",
          boundAt: T,
          state: "live",
          paneId: "pane-1",
        },
        {
          agent: "opencode",
          sessionId: "done-1",
          cwd: "/repo",
          title: "polish",
          boundAt: T,
          state: "closed",
          endedAt: T,
        },
      ],
    };
    const lines = snapshotJournal(records).map(encodeJournalEvent);
    expect(foldJournal(decodeJournalLines(lines).events)).toEqual(records);
  });
});

describe("shouldCompactJournal", () => {
  it("compacts only a long, mostly-superseded log", () => {
    expect(shouldCompactJournal(100, 1, 0)).toBe(false); // short
    expect(shouldCompactJournal(600, 500, 0)).toBe(false); // still contributing
    expect(shouldCompactJournal(900, 100, 0)).toBe(true);
  });

  it("any foreign line vetoes — a rewrite would drop a newer build's data", () => {
    expect(shouldCompactJournal(900, 100, 1)).toBe(false);
  });
});
