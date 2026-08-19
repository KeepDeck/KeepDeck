import { describe, expect, it } from "vitest";
import type { JoinEntry } from "./join";
import type { SessionRecord } from "./sessionLog";
import { composeSessionBlocks } from "./blocks";
import { rowKeyOf, rowOfHit, type UnifiedSessionRow } from "./sessionRow";

const T0 = 1_000;
const T = (ms: number) => new Date(ms).toISOString();

const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo",
    boundAt: T(T0),
    state: "closed",
    endedAt: T(T0),
    ...over,
  }) as SessionRecord;

const NO_ENTRIES: ReadonlyMap<string, JoinEntry> = new Map();
const NO_SCAN = new Set<string>();
const LABEL = (id: string) => (id === "claude" ? "Claude Code" : undefined);

const hit = (over: {
  agent?: string;
  sessionId: string;
  mtime: number;
  title?: string;
  cwd?: string;
}): UnifiedSessionRow =>
  rowOfHit({
    agent: over.agent ?? "claude",
    sessionId: over.sessionId,
    reference: `/store/${over.sessionId}`,
    cwd: over.cwd ?? "/repo",
    title: over.title ?? null,
    transcriptPath: null,
    mtime: over.mtime,
  });

const compose = (over: Partial<Parameters<typeof composeSessionBlocks>[0]> = {}) =>
  composeSessionBlocks({
    records: [],
    query: "",
    entries: NO_ENTRIES,
    agentLabel: LABEL,
    answerMayChange: false,
    scannedAgents: NO_SCAN,
    topHits: [],
    bottomHits: [],
    topTotal: 0,
    bottomTotal: 0,
    ...over,
  });

describe("composeSessionBlocks — T1: the journal-record query predicate", () => {
  // Truth table: each field alone matches; a fieldless record doesn't.
  it("each of the four fields matches alone; none matches garbage", () => {
    const cases: Array<[Partial<SessionRecord>, string]> = [
      [{ title: "fix the auth bug" }, "auth"],
      [{ cwd: "/wt/kd-x-1" }, "kd-x"],
      [{ branch: "kd/ws/1" }, "ws/1"],
      [{ sessionId: "zz-9" }, "zz-9"],
    ];
    for (const [over, q] of cases) {
      const { top } = compose({
        records: [record({ ...over, sessionId: (over as { sessionId?: string }).sessionId ?? "s-1" })],
        query: q,
      });
      expect(top.rows.map((r) => r.sessionId)).toEqual([
        (over as { sessionId?: string }).sessionId ?? "s-1",
      ]);
    }
    // Nothing matches a query none of the fields carry.
    const { top } = compose({ records: [record({ title: "x" })], query: "zzz" });
    expect(top.rows).toEqual([]);
    // Case-insensitive by folding BOTH sides, not just the query.
    const { top: ci } = compose({
      records: [record({ title: "Auth Bug" })],
      query: "AUTH",
    });
    expect(ci.rows).toHaveLength(1);
  });

  it("substring, not prefix; a removed field stops matching", () => {
    // startsWith would fail the middle-of-string cwd match.
    const { top } = compose({ records: [record({ cwd: "/home/kd/x" })], query: "kd" });
    expect(top.rows).toHaveLength(1);
    // Dropping the field from the predicate's set: the branch-only match.
    const { top: br } = compose({ records: [record({ branch: "feat/x" })], query: "feat" });
    expect(br.rows).toHaveLength(1);
  });
});

describe("composeSessionBlocks — T1b: the title's SOURCE, not the join's paint", () => {
  it("a record whose JOURNAL title doesn't match stays hidden even when the index title would", () => {
    // The record's own title is X; the enrichment answer carries an index
    // title Y; the query is Y. The row must NOT pass: enrichment paints
    // cells, it never decides composition — a joined title arriving late
    // must not make a filtered row appear. (The top block's INDEX half
    // finds Y by content — the union keeps it findable that way.)
    const { top } = compose({
      records: [record({ title: "unrelated journal title" })],
      query: "index answer words",
      entries: new Map([
        [rowKeyOf({ agent: "claude", sessionId: "s-1" }), {
          kind: "hit",
          reference: "/store/s-1",
          title: "index answer words",
          mtime: 5,
        }],
      ]),
    });
    expect(top.rows).toEqual([]);
  });
});

describe("composeSessionBlocks — T2: a twin with an EMPTY cwd rides the top once", () => {
  it("the journal knows K; both hit sets carry K with an empty cwd — top once, bottom never", () => {
    const twinTop = hit({ sessionId: "s-1", mtime: 5, cwd: "" });
    const twinBottom = hit({ sessionId: "s-1", mtime: 5, cwd: "" });
    const { top, bottom } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      topHits: [twinTop],
      bottomHits: [twinBottom],
      topTotal: 1,
      bottomTotal: 1,
    });
    expect(top.rows.map((r) => r.sessionId)).toEqual(["s-1"]); // ONCE
    expect(bottom.rows).toEqual([]); // never below
  });
});

describe("composeSessionBlocks — T3: binding outranks the folder rule", () => {
  it("a journal record with its folder OUTSIDE the workspace set stays top; the bottom twin is subtracted", () => {
    // The main phrase, as a test: binding is a recorded FACT — no folder
    // filter may unseat it. (The folder SET itself lives in the query;
    // here the twin arrives via the bottom set, which the composition
    // must still de-twin.)
    const { top, bottom } = compose({
      records: [record({ cwd: "/foreign" })],
      bottomHits: [hit({ sessionId: "s-1", mtime: 5, cwd: "/foreign" })],
      bottomTotal: 1
    });
    expect(top.rows.map((r) => r.sessionId)).toEqual(["s-1"]);
    expect(bottom.rows).toEqual([]);
  });
});

describe("composeSessionBlocks — T4: the top block is a UNION on one axis", () => {
  it("journal row + workspace hit the journal lacks — both top, ordered by the axis; the global hit stays below", () => {
    const { top, bottom } = compose({
      records: [record({ endedAt: T(200) })],
      topHits: [hit({ sessionId: "w-1", mtime: 500 })],
      bottomHits: [hit({ sessionId: "g-1", mtime: 900 })],
      topTotal: 1,
      bottomTotal: 1,
    });
    expect(top.rows.map((r) => r.sessionId)).toEqual(["w-1", "s-1"]); // axis order
    expect(bottom.rows.map((r) => r.sessionId)).toEqual(["g-1"]);
  });
});

describe("composeSessionBlocks — T5: the COMPOSITE axis, proven by contradiction", () => {
  // Two input rows whose own marks CONTRADICT the axis rule in opposite
  // directions: without the contradiction inside each row, "always the
  // journal mark" and the true rule give ONE order and the test passes
  // on both.
  it("(a) mtime outranks a LATER journal mark; (a′) a later mtime outranks the journal mark", () => {
    // (a): the journal mark is LATER than mtime — the axis must place
    // this row by its mtime (below the older-mtime row), not by its
    // journal mark (above).
    const a = record({
      sessionId: "a",
      endedAt: T(300),
      transcriptPath: "/j/a",
    });
    // The index answer for `a` with an EARLIER mtime.
    const entries = new Map<string, JoinEntry>([
      [rowKeyOf({ agent: "claude", sessionId: "a" }), {
        kind: "hit",
        reference: "/store/a",
        title: null,
        mtime: 100,
      }],
    ]);
    // (c): a plain hit between the two.
    const c = hit({ sessionId: "c", mtime: 200 });
    const { top } = compose({ records: [a], entries, topHits: [c], topTotal: 1 });
    expect(top.rows.map((r) => r.sessionId)).toEqual(["c", "a"]); // by mtime, not the mark

    // (a′): the mirror — mtime LATER than the journal mark.
    const a2 = record({ sessionId: "a2", endedAt: T(100) });
    const entries2 = new Map<string, JoinEntry>([
      [rowKeyOf({ agent: "claude", sessionId: "a2" }), {
        kind: "hit",
        reference: "/store/a2",
        title: null,
        mtime: 300,
      }],
    ]);
    const c2 = hit({ sessionId: "c2", mtime: 200 });
    const { top: top2 } = compose({ records: [a2], entries: entries2, topHits: [c2], topTotal: 1 });
    expect(top2.rows.map((r) => r.sessionId)).toEqual(["a2", "c2"]); // mtime wins again
  });

  it("(b) an index-unknown row stands by its journal mark among mtime rows — it does not sink", () => {
    const b = record({ sessionId: "b", endedAt: T(200) });
    const above = hit({ sessionId: "hi", mtime: 400 });
    const below = hit({ sessionId: "lo", mtime: 100 });
    const { top } = compose({ records: [b], topHits: [above, below], topTotal: 2 });
    expect(top.rows.map((r) => r.sessionId)).toEqual(["hi", "b", "lo"]);
  });
});

describe("composeSessionBlocks — T6: a late answer RE-SEATS its row, composition intact", () => {
  it("an enrichment answer arriving later moves the row to its landed time; the block's size does not change", () => {
    const x = record({ sessionId: "x", endedAt: T(100) });
    const y = record({ sessionId: "y", endedAt: T(300) });
    const before = compose({ records: [x, y] });
    expect(before.top.rows.map((r) => r.sessionId)).toEqual(["y", "x"]);

    const after = compose({
      records: [x, y],
      entries: new Map([
        [rowKeyOf({ agent: "claude", sessionId: "x" }), {
          kind: "hit",
          reference: "/store/x",
          title: null,
          mtime: 900,
        }],
      ]),
    });
    expect(after.top.rows.map((r) => r.sessionId)).toEqual(["x", "y"]); // re-seated
    expect(after.top.rows).toHaveLength(2); // composition unchanged
    expect(before.top.rows).toHaveLength(2);
  });
});

describe("composeSessionBlocks — the counters the composition itself returns", () => {
  it("twin subtraction and the loaded floor are computed where the rule lives", () => {
    // Loaded 10 over a shrunken engine total of 8, one twin among the
    // loaded: the denominator floors at 10 (not 8 — the engine's type
    // does not promise loaded ≤ total) and drops the twin.
    const twins = [hit({ sessionId: "s-1", mtime: 5 })];
    const others = Array.from({ length: 9 }, (_, i) =>
      hit({ sessionId: `o-${i}`, mtime: 100 + i }),
    );
    const { top } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      topHits: [...twins, ...others],
      topTotal: 8
    });
    expect(top.shown).toBe(10); // journal 1 + kept 9
    expect(top.total).toBe(10); // 1 + max(8,10) − 1 twin
  });

  // ── C0: numerator ≤ denominator ALWAYS; equality at full load ──────
  // Twins in the inputs are load-bearing — without one, the inequality
  // holds trivially under any implementation.

  it("C0(i): a twin in the TOP — full load reaches equality", () => {
    // Journal 1 + engine [twin, stranger] fully loaded (total 2):
    // drawn 2, denominator 1 + 2 − 1 = 2 — EQUAL at full load.
    const { top } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      topHits: [hit({ sessionId: "s-1", mtime: 5 }), hit({ sessionId: "w-1", mtime: 6 })],
      topTotal: 2
    });
    expect(top.shown).toBe(2);
    expect(top.total).toBe(2);
    expect(top.shown).toBeLessThanOrEqual(top.total);
  });

  it("C0(ii): a twin in the BOTTOM (the empty-cwd shape) — inequality holds, equality at full load", () => {
    const { bottom } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      bottomHits: [
        hit({ sessionId: "s-1", mtime: 5, cwd: "" }),
        hit({ sessionId: "g-1", mtime: 6 }),
      ],
      bottomTotal: 2
    });
    expect(bottom.shown).toBe(1);
    expect(bottom.total).toBe(1); // 2 − 1 twin, full load: EQUAL
    expect(bottom.shown).toBeLessThanOrEqual(bottom.total);
  });

  it("C0(iii): partial load with twins in BOTH blocks — strict inequality, never inverted", () => {
    const { top, bottom } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      topHits: [hit({ sessionId: "s-1", mtime: 5 })],
      topTotal: 7,
      bottomHits: [hit({ sessionId: "s-1", mtime: 5, cwd: "" })],
      bottomTotal: 9,
    });
    expect(top.shown).toBe(1); // the journal row only
    expect(top.total).toBe(7); // 1 journal + 7 − 1 twin
    expect(top.shown).toBeLessThan(top.total);
    expect(bottom.shown).toBe(0);
    expect(bottom.total).toBe(8); // 9 − 1 twin
    expect(bottom.shown).toBeLessThan(bottom.total);
  });

  it("C0-lower: the bottom's max floor — a shrunken engine total under loaded hits", () => {
    // The engine does not promise loaded ≤ total: a shrinking total
    // between pages reaches 10 loaded over 8. With one twin among the
    // loaded: drawn 9, denominator max(8, 10) − 1 = 9 — EQUAL, invariant
    // intact. Without the LOWER max the total reads 8 − 1 = 7 and the
    // numerator overshoots it — the very lie the floor exists for.
    const { bottom } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      bottomHits: [
        hit({ sessionId: "s-1", mtime: 5, cwd: "" }),
        ...Array.from({ length: 9 }, (_, i) => hit({ sessionId: `k-${i}`, mtime: 10 + i })),
      ],
      bottomTotal: 8
    });
    expect(bottom.shown).toBe(9);
    expect(bottom.total).toBe(9);
    expect(bottom.shown).toBeLessThanOrEqual(bottom.total);
  });

  it("C0b: as pages land at an UNCHANGED raw total, the denominator−numerator gap never grows — the twin arrives on the second page", () => {
    const journal = [record({ transcriptPath: "/j/s-1" })];
    // Page 1: a stranger only.
    const page1 = compose({
      records: journal,
      topHits: [hit({ sessionId: "a", mtime: 5 })],
      topTotal: 3
    });
    // Page 2: the twin lands among the loaded.
    const page2 = compose({
      records: journal,
      topHits: [hit({ sessionId: "a", mtime: 5 }), hit({ sessionId: "s-1", mtime: 4 })],
      topTotal: 3
    });
    const gap1 = page1.top.total - page1.top.shown;
    const gap2 = page2.top.total - page2.top.shown;
    // page1: total 1+3−0=4, shown 2 → gap 2; page2: total 1+3−1=3,
    // shown 2 → gap 1. The twin's arrival SHRANK the gap by exactly
    // itself — no off-by-one growth.
    expect(gap1).toBe(2);
    expect(gap2).toBe(1);
    expect(gap2).toBeLessThanOrEqual(gap1);
  });
});
