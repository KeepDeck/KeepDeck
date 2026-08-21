import { describe, expect, it } from "vitest";
import type { JoinEntry } from "./join";
import type { SessionRecord } from "./sessionLog";
import { composeSessionList } from "./session-list";
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

const compose = (over: Partial<Parameters<typeof composeSessionList>[0]> = {}) =>
  composeSessionList({
    records: [],
    query: "",
    entries: NO_ENTRIES,
    agentLabel: LABEL,
    answerMayChange: false,
    workspaceHits: [],
    otherHits: [],
    workspaceTotal: 0,
    otherTotal: 0,
    ...over,
  });

describe("composeSessionList — T1: the journal-record query predicate", () => {
  // Truth table: each field alone matches; a fieldless record doesn't.
  it("each of the four fields matches alone; none matches garbage", () => {
    const cases: Array<[Partial<SessionRecord>, string]> = [
      [{ title: "fix the auth bug" }, "auth"],
      [{ cwd: "/wt/kd-x-1" }, "kd-x"],
      [{ branch: "kd/ws/1" }, "ws/1"],
      [{ sessionId: "zz-9" }, "zz-9"],
    ];
    for (const [over, q] of cases) {
      const { workspace } = compose({
        records: [record({ ...over, sessionId: (over as { sessionId?: string }).sessionId ?? "s-1" })],
        query: q,
      });
      expect(workspace.rows.map((r) => r.sessionId)).toEqual([
        (over as { sessionId?: string }).sessionId ?? "s-1",
      ]);
    }
    // Nothing matches a query none of the fields carry.
    const { workspace } = compose({ records: [record({ title: "x" })], query: "zzz" });
    expect(workspace.rows).toEqual([]);
    // Case-insensitive by folding BOTH sides, not just the query.
    const { workspace: ci } = compose({
      records: [record({ title: "Auth Bug" })],
      query: "AUTH",
    });
    expect(ci.rows).toHaveLength(1);
  });

  it("substring, not prefix; a removed field stops matching", () => {
    // startsWith would fail the middle-of-string cwd match.
    const { workspace } = compose({ records: [record({ cwd: "/home/kd/x" })], query: "kd" });
    expect(workspace.rows).toHaveLength(1);
    // Dropping the field from the predicate's set: the branch-only match.
    const { workspace: br } = compose({ records: [record({ branch: "feat/x" })], query: "feat" });
    expect(br.rows).toHaveLength(1);
  });
});

describe("composeSessionList — T1b: the title's SOURCE, not the join's paint", () => {
  it("a record whose JOURNAL title doesn't match stays hidden even when the index title would", () => {
    // The record's own title is X; the enrichment answer carries an index
    // title Y; the query is Y. The row must NOT pass: enrichment paints
    // cells, it never decides composition — a joined title arriving late
    // must not make a filtered row appear. (The workspace track's INDEX
    // half finds Y by content — the union keeps it findable that way.)
    const { workspace } = compose({
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
    expect(workspace.rows).toEqual([]);
  });
});

describe("composeSessionList — T2: a twin with an EMPTY cwd rides the workspace track once", () => {
  it("the journal knows K; both hit sets carry K with an empty cwd — once in the queue, ahead of every other row, never among them", () => {
    const twinWorkspace = hit({ sessionId: "s-1", mtime: 5, cwd: "" });
    const twinOther = hit({ sessionId: "s-1", mtime: 5, cwd: "" });
    const { workspace, other } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      workspaceHits: [twinWorkspace],
      otherHits: [twinOther],
      workspaceTotal: 1,
      otherTotal: 1,
    });
    expect(workspace.rows.map((r) => r.sessionId)).toEqual(["s-1"]); // ONCE
    expect(other.rows).toEqual([]); // never among the other rows
  });
});

describe("composeSessionList — T3: binding outranks the folder rule", () => {
  it("a journal record with its folder OUTSIDE the workspace set rides the queue ahead of every other row, exactly once; its other-track twin is subtracted", () => {
    // The main phrase, as a test: binding is a recorded FACT — no folder
    // filter may unseat it. (The folder SET itself lives in the query;
    // here the twin arrives via the other track's set, which the
    // composition must still de-twin.)
    const { workspace, other } = compose({
      records: [record({ cwd: "/foreign" })],
      otherHits: [hit({ sessionId: "s-1", mtime: 5, cwd: "/foreign" })],
      otherTotal: 1
    });
    expect(workspace.rows.map((r) => r.sessionId)).toEqual(["s-1"]);
    expect(other.rows).toEqual([]);
  });
});

describe("composeSessionList — T4: the workspace track is a UNION on one axis", () => {
  it("journal row + workspace hit the journal lacks — both in the workspace track, ordered by the axis; the other row stays below", () => {
    const { workspace, other } = compose({
      records: [record({ endedAt: T(200) })],
      workspaceHits: [hit({ sessionId: "w-1", mtime: 500 })],
      otherHits: [hit({ sessionId: "g-1", mtime: 900 })],
      workspaceTotal: 1,
      otherTotal: 1,
    });
    expect(workspace.rows.map((r) => r.sessionId)).toEqual(["w-1", "s-1"]); // axis order
    expect(other.rows.map((r) => r.sessionId)).toEqual(["g-1"]);
  });
});

describe("composeSessionList — T5: the COMPOSITE axis, proven by contradiction", () => {
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
    const { workspace } = compose({ records: [a], entries, workspaceHits: [c], workspaceTotal: 1 });
    expect(workspace.rows.map((r) => r.sessionId)).toEqual(["c", "a"]); // by mtime, not the mark

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
    const { workspace: workspace2 } = compose({ records: [a2], entries: entries2, workspaceHits: [c2], workspaceTotal: 1 });
    expect(workspace2.rows.map((r) => r.sessionId)).toEqual(["a2", "c2"]); // mtime wins again
  });

  it("(b) an index-unknown row stands by its journal mark among mtime rows — it does not sink", () => {
    const b = record({ sessionId: "b", endedAt: T(200) });
    const above = hit({ sessionId: "hi", mtime: 400 });
    const below = hit({ sessionId: "lo", mtime: 100 });
    const { workspace } = compose({ records: [b], workspaceHits: [above, below], workspaceTotal: 2 });
    expect(workspace.rows.map((r) => r.sessionId)).toEqual(["hi", "b", "lo"]);
  });
});

describe("composeSessionList — T6: a late answer RE-SEATS its row, composition intact", () => {
  it("an enrichment answer arriving later moves the row to its landed time; the list's size does not change", () => {
    const x = record({ sessionId: "x", endedAt: T(100) });
    const y = record({ sessionId: "y", endedAt: T(300) });
    const before = compose({ records: [x, y] });
    expect(before.workspace.rows.map((r) => r.sessionId)).toEqual(["y", "x"]);

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
    expect(after.workspace.rows.map((r) => r.sessionId)).toEqual(["x", "y"]); // re-seated
    expect(after.workspace.rows).toHaveLength(2); // composition unchanged
    expect(before.workspace.rows).toHaveLength(2);
  });
});

describe("composeSessionList — the counters the composition itself returns", () => {
  // ── The loaded floor, SPLIT BY TRACK ───────────────────────────────
  // The engine does not promise loaded ≤ total (a shrinking total
  // between pages reaches the state), so each track's denominator floors
  // at its own max(raw, loaded). One witness per floor, inputs SEPARATED
  // — the shrunken total rides ONE track per case and the other track
  // carries nothing: removing either max must redden ITS case and ONLY
  // its case (mutual non-redness is what proves the floors distinct —
  // one shared-input test covering both is coverage in appearance).

  it("the WORKSPACE track's floor: shrunken total in the workspace track only", () => {
    // 10 loaded over a shrunken total of 8, one twin among the loaded:
    // drawn 10, denominator 1 + max(8, 10) − 1 twin = 10 — the numerator
    // never overshoots. Without the workspace max: 1 + 8 − 1 = 8 under 10.
    const twins = [hit({ sessionId: "s-1", mtime: 5 })];
    const others = Array.from({ length: 9 }, (_, i) =>
      hit({ sessionId: `o-${i}`, mtime: 100 + i }),
    );
    const { workspace } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      workspaceHits: [...twins, ...others],
      workspaceTotal: 8,
    });
    expect(workspace.shown).toBe(10); // journal 1 + kept 9
    expect(workspace.total).toBe(10); // 1 + max(8,10) − 1 twin
  });

  it("the OTHER track's floor: shrunken total in the other track only", () => {
    // The mirror, isolated: 10 loaded over 8 in the other track, one
    // twin — drawn 9, denominator max(8, 10) − 1 = 9, EQUAL. Without the
    // other max: 8 − 1 = 7 under 9. The workspace track carries only the
    // journal record (its floor computes 1 either way — this case must
    // stay green when the workspace max is the one removed).
    const { other } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      otherHits: [
        hit({ sessionId: "s-1", mtime: 5, cwd: "" }),
        ...Array.from({ length: 9 }, (_, i) => hit({ sessionId: `k-${i}`, mtime: 10 + i })),
      ],
      otherTotal: 8,
    });
    expect(other.shown).toBe(9);
    expect(other.total).toBe(9);
    expect(other.shown).toBeLessThanOrEqual(other.total);
  });

  // ── C0: numerator ≤ denominator ALWAYS; equality at full load ──────
  // Twins in the inputs are load-bearing — without one, the inequality
  // holds trivially under any implementation.

  it("C0(i): a twin in the WORKSPACE track — full load reaches equality", () => {
    // Journal 1 + engine [twin, stranger] fully loaded (total 2):
    // drawn 2, denominator 1 + 2 − 1 = 2 — EQUAL at full load.
    const { workspace } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      workspaceHits: [hit({ sessionId: "s-1", mtime: 5 }), hit({ sessionId: "w-1", mtime: 6 })],
      workspaceTotal: 2
    });
    expect(workspace.shown).toBe(2);
    expect(workspace.total).toBe(2);
    expect(workspace.shown).toBeLessThanOrEqual(workspace.total);
  });

  it("C0-listCount: the field's count sums the tracks' COMPOSED numbers — never the engines' raw totals", () => {
    // Deliberately ASYMMETRIC fixture: journal 2 (one a twin of a
    // workspace hit); the workspace track loaded 3 (1 twin + 2
    // strangers), raw total 6; the other track loaded 2, no twins, raw
    // total 7. Tracks: workspace 4 of 7, other 2 of 7; the list's count
    // 6 of 14. The raw-total sum is 13 ≠ 14 — journal rows (2) outnumber
    // the twins (1), so summing raw totals reddens here.
    const { workspace, other, listCount } = compose({
      records: [
        record({ transcriptPath: "/j/s-1" }),
        record({ sessionId: "s-2" }),
      ],
      workspaceHits: [
        hit({ sessionId: "s-1", mtime: 5 }),
        hit({ sessionId: "w-1", mtime: 6 }),
        hit({ sessionId: "w-2", mtime: 7 }),
      ],
      otherHits: [hit({ sessionId: "b-1", mtime: 4 }), hit({ sessionId: "b-2", mtime: 3 })],
      workspaceTotal: 6,
      otherTotal: 7,
    });
    expect(`${workspace.shown} of ${workspace.total}`).toBe("4 of 7");
    expect(`${other.shown} of ${other.total}`).toBe("2 of 7");
    expect(listCount).toEqual({ shown: 6, total: 14 });
    expect(listCount.shown).toBeLessThanOrEqual(listCount.total);
  });

  it("C0(ii): a twin in the OTHER track (the empty-cwd shape) — inequality holds, equality at full load", () => {
    const { other } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      otherHits: [
        hit({ sessionId: "s-1", mtime: 5, cwd: "" }),
        hit({ sessionId: "g-1", mtime: 6 }),
      ],
      otherTotal: 2
    });
    expect(other.shown).toBe(1);
    expect(other.total).toBe(1); // 2 − 1 twin, full load: EQUAL
    expect(other.shown).toBeLessThanOrEqual(other.total);
  });

  it("C0(iii): partial load with twins in BOTH tracks — strict inequality, never inverted", () => {
    const { workspace, other } = compose({
      records: [record({ transcriptPath: "/j/s-1" })],
      workspaceHits: [hit({ sessionId: "s-1", mtime: 5 })],
      workspaceTotal: 7,
      otherHits: [hit({ sessionId: "s-1", mtime: 5, cwd: "" })],
      otherTotal: 9,
    });
    expect(workspace.shown).toBe(1); // the journal row only
    expect(workspace.total).toBe(7); // 1 journal + 7 − 1 twin
    expect(workspace.shown).toBeLessThan(workspace.total);
    expect(other.shown).toBe(0);
    expect(other.total).toBe(8); // 9 − 1 twin
    expect(other.shown).toBeLessThan(other.total);
  });

  it("C0b: as pages land at an UNCHANGED raw total, the denominator−numerator gap never grows — the twin arrives on the second page", () => {
    const journal = [record({ transcriptPath: "/j/s-1" })];
    // Page 1: a stranger only.
    const page1 = compose({
      records: journal,
      workspaceHits: [hit({ sessionId: "a", mtime: 5 })],
      workspaceTotal: 3
    });
    // Page 2: the twin lands among the loaded.
    const page2 = compose({
      records: journal,
      workspaceHits: [hit({ sessionId: "a", mtime: 5 }), hit({ sessionId: "s-1", mtime: 4 })],
      workspaceTotal: 3
    });
    const gap1 = page1.workspace.total - page1.workspace.shown;
    const gap2 = page2.workspace.total - page2.workspace.shown;
    // page1: total 1+3−0=4, shown 2 → gap 2; page2: total 1+3−1=3,
    // shown 2 → gap 1. The twin's arrival SHRANK the gap by exactly
    // itself — no off-by-one growth.
    expect(gap1).toBe(2);
    expect(gap2).toBe(1);
    expect(gap2).toBeLessThanOrEqual(gap1);
  });
});
