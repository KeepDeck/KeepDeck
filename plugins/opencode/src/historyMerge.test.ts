import { describe, expect, it } from "vitest";
import {
  mergeSessions,
  mergeTurns,
  migrationOf,
  storeShape,
  transcriptOf,
  type Turn,
  type V1Session,
  type V2Session,
} from "./historyMerge";

const V1 = ["session", "message", "part"];
const V2 = ["session_v2", "session_message", "event_sequence"];

describe("storeShape", () => {
  it("tells the two table sets apart", () => {
    expect(storeShape(V1)).toEqual({ v1: true, v2: false, kv: false });
    expect(storeShape([...V2, "kv"])).toEqual({ v1: false, v2: true, kv: true });
    expect(storeShape([...V1, ...V2, "kv"])).toEqual({ v1: true, v2: true, kv: true });
  });

  it("does not take 1.19.3's empty session_message for the 2.x store", () => {
    expect(storeShape([...V1, "session_message"]).v2).toBe(false);
  });
});

describe("migrationOf", () => {
  const both = storeShape([...V1, ...V2, "kv"]);

  it("has nothing to reconcile with one table set — marker or not", () => {
    // A fresh 2.x store writes no marker at all and is complete.
    expect(migrationOf(storeShape(V2), undefined)).toEqual({ state: "none" });
    expect(migrationOf(storeShape(V1), undefined)).toEqual({ state: "none" });
  });

  it("reads a finished copy with its time", () => {
    expect(migrationOf(both, { phase: "completed", at: 5000 })).toEqual({
      state: "completed",
      at: 5000,
    });
  });

  it("calls a copy under way, or one that left no marker, pending", () => {
    expect(migrationOf(both, { phase: "sessions", at: 5000 })).toEqual({ state: "pending" });
    expect(migrationOf(both, undefined)).toEqual({ state: "pending" });
    expect(migrationOf(both, { phase: null, at: 5000 })).toEqual({ state: "pending" });
  });
});

const v1 = (id: string, over: Partial<V1Session> = {}): V1Session => ({
  id,
  created: 100,
  updated: 1000,
  archived: false,
  partMax: 0,
  ...over,
});
const v2 = (id: string, over: Partial<V2Session> = {}): V2Session => ({
  id,
  updated: 2000,
  archived: false,
  seq: 1,
  ...over,
});
const ids = (stubs: { sessionId: string }[]) => stubs.map((stub) => stub.sessionId).sort();
const copied = { state: "completed" as const, at: 5000 };

describe("mergeSessions", () => {
  it("reads one table set the way it always was read", () => {
    expect(mergeSessions([v1("a", { updated: 1700, partMax: 5 })], [], { state: "none" })).toEqual([
      { sessionId: "a", ref: "a", mtime: 1700, size: 5 },
    ]);
    expect(mergeSessions([], [v2("b", { updated: 4000, seq: 10 })], { state: "none" })).toEqual([
      { sessionId: "b", ref: "b", mtime: 4000, size: 10 },
    ]);
  });

  it("does not bring back a session 2.x deleted after the copy", () => {
    // Its 1.x rows outlive the deletion; only the copy's time says it was
    // there before, so its absence from 2.x is a deletion.
    expect(mergeSessions([v1("deleted", { created: 4000 })], [], copied)).toEqual([]);
  });

  it("keeps a session 1.x made after the copy", () => {
    expect(ids(mergeSessions([v1("later", { created: 6000 })], [], copied))).toEqual(["later"]);
  });

  it("keeps every 1.x session while the copy is under way", () => {
    expect(ids(mergeSessions([v1("old", { created: 1 })], [], { state: "pending" }))).toEqual([
      "old",
    ]);
  });

  it("lists a session in both once, fingerprinted by whichever side moved", () => {
    const both = (a: Partial<V1Session>, b: Partial<V2Session>) =>
      mergeSessions([v1("s", a)], [v2("s", b)], copied);

    expect(both({ updated: 1000, partMax: 900 }, { updated: 2000, seq: 3 })).toEqual([
      { sessionId: "s", ref: "s", mtime: 2000, size: 903 },
    ]);
    // A 1.x continuation moves the 1.x half; a 2.x event moves the other.
    expect(both({ updated: 9000, partMax: 9100 }, { updated: 2000, seq: 3 })[0]).toMatchObject({
      mtime: 9000,
      size: 9103,
    });
    expect(both({ updated: 1000, partMax: 900 }, { updated: 2000, seq: 4 })[0]).toMatchObject({
      size: 904,
    });
  });

  it("lets 2.x decide whether a session in both is archived", () => {
    expect(mergeSessions([v1("s")], [v2("s", { archived: true })], copied)).toEqual([]);
    expect(ids(mergeSessions([v1("s", { archived: true })], [v2("s")], copied))).toEqual(["s"]);
  });

  it("hides an archived session that only one side has", () => {
    const later = { created: 6000, archived: true };
    expect(mergeSessions([v1("a", later)], [v2("b", { archived: true })], copied)).toEqual([]);
  });
});

const turn = (id: string, text: string, over: Partial<Turn> = {}): Turn => ({
  id,
  role: "user",
  text,
  unreadable: 0,
  ...over,
});

describe("mergeTurns", () => {
  it("takes a message both sides have from 2.x, and adds what only 1.x has after", () => {
    const merged = mergeTurns(
      [turn("m1", "as copied"), turn("m2", "said in 2.x")],
      [turn("m1", "as 1.x had it"), turn("m3", "said in 1.x")],
    );
    expect(merged.map((t) => t.text)).toEqual(["as copied", "said in 2.x", "said in 1.x"]);
  });

  it("drops 1.x's compaction summary when 2.x holds the compaction", () => {
    const summary = turn("sum", "the summary", { role: "assistant", summarizes: "c" });
    expect(mergeTurns([turn("c", "the summary", { role: "other" })], [summary])).toHaveLength(1);
    // Without the compaction in 2.x, it is 1.x's own conversation: kept.
    expect(mergeTurns([], [summary])).toEqual([summary]);
  });
});

describe("transcriptOf", () => {
  it("shows the turns with text and counts every row that did not parse", () => {
    expect(
      transcriptOf([
        turn("a", "hi", { unreadable: 1 }),
        turn("b", "", { unreadable: 2 }),
        turn("c", "", { role: "other" }),
      ]),
    ).toEqual({ entries: [{ role: "user", text: "hi" }], unreadable: 3 });
  });
});
