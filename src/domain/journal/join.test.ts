import { describe, expect, it } from "vitest";
import type { SessionRecord } from "./sessionLog";
import { joinJournalRow, type JoinEntry } from "./join";

const record = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo",
    boundAt: "2026-07-19T10:00:00.000Z",
    state: "closed",
    endedAt: "2026-07-19T11:00:00.000Z",
    ...over,
  }) as SessionRecord;

const LABEL = "Claude Code";
/** The join's fourth and fifth arguments for the common case: the answer
 * is settled, and the agent's store was scanned (the file-erased verdict
 * allowed to fire when its inputs say so). */
const SETTLED_SCANNED = [false, true] as const;

describe("joinJournalRow", () => {
  it("a row without its own name takes the index's title; a meaningful own name keeps it", () => {
    const named = joinJournalRow(
      record({ title: "fix the auth bug" }),
      { kind: "hit", reference: "/store/s-1", title: "index says otherwise", mtime: 5000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(named.title).toBe("fix the auth bug");

    const nameless = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: "index title", mtime: 5000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(nameless.title).toBe("index title");

    const blank = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: null, mtime: 5000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(blank.title).toBeUndefined();
  });

  it("a title equal to the agent's LABEL is the frozen fallback, not a name — the index title wins", () => {
    // The two live records literally titled "Claude Code": without this
    // rule the join would keep the label as a title and the complaint
    // stays half-open.
    const joined = joinJournalRow(
      record({ title: LABEL }),
      { kind: "hit", reference: "/store/s-1", title: "the real conversation", mtime: 5000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(joined.title).toBe("the real conversation");
    // With no index answer to fall back on, the label-title is simply
    // gone — the caller's fallback chain renders the same label anyway.
    const unanswered = joinJournalRow(record({ title: LABEL }), undefined, LABEL, ...SETTLED_SCANNED);
    expect(unanswered.title).toBeUndefined();
    // No agent info (plugin gone) → no label to compare against; the
    // title stands as the record's own.
    const noLabel = joinJournalRow(record({ title: LABEL }), undefined, undefined, ...SETTLED_SCANNED);
    expect(noLabel.title).toBe(LABEL);
  });

  it("the read link is the UNION: journal path first, the index's reference when the journal has none", () => {
    const both = joinJournalRow(
      record({ transcriptPath: "/journal/s-1.jsonl" }),
      { kind: "hit", reference: "/store/s-1", title: null, mtime: 5000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(both.read).toEqual({ source: "journal", reference: "/journal/s-1.jsonl" });

    const onlyIndex = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: null, mtime: 5000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(onlyIndex.read).toEqual({ source: "index", reference: "/store/s-1" });

    const neither = joinJournalRow(record(), { kind: "absent" }, LABEL, false, false);
    expect(neither.read).toBeNull();
  });

  it("a journal path keeps the row readable against every index answer but ONE — failure never degrades the known", () => {
    // The one exception is the file-erased VERDICT (below): it claims the
    // path's file is gone, not that the row is unreadable. Every other
    // answer leaves a path-bearing row statusless and openable.
    const answers: (JoinEntry | undefined)[] = [
      undefined,
      { kind: "error" },
    ];
    for (const entry of answers) {
      const joined = joinJournalRow(
        record({ transcriptPath: "/journal/s-1.jsonl" }),
        entry,
        LABEL,
        ...SETTLED_SCANNED,
      );
      expect(joined.read).toEqual({ source: "journal", reference: "/journal/s-1.jsonl" });
      expect(joined.status).toBeNull();
    }
    // An absent answer with the store NOT scanned: no verdict owed.
    const unscanned = joinJournalRow(
      record({ transcriptPath: "/journal/s-1.jsonl" }),
      { kind: "absent" },
      LABEL,
      false,
      false,
    );
    expect(unscanned.read).toEqual({ source: "journal", reference: "/journal/s-1.jsonl" });
    expect(unscanned.status).toBeNull();
  });

  it("the file-erased verdict in its three positions", () => {
    const withPath = record({ transcriptPath: "/journal/s-1.jsonl" });
    // Path + settled absence + scanned store → the file is erased, said
    // BEFORE the click.
    expect(
      joinJournalRow(withPath, { kind: "absent" }, LABEL, false, true).status,
    ).toBe("file-erased");
    // Same input while the answer may still change → not a verdict yet.
    expect(
      joinJournalRow(withPath, { kind: "absent" }, LABEL, true, true).status,
    ).toBeNull(); // readable row, still indexing elsewhere — no chip
    // Same input, agent's store never scanned → NO verdict at all: its
    // absence from the index proves nothing.
    expect(
      joinJournalRow(withPath, { kind: "absent" }, LABEL, false, false).status,
    ).toBeNull();
  });

  it("a wrong-owner row is visible but never opens: the guard outranks its own journal path", () => {
    // The corrupted records: journal says claude, the path leads into the
    // kimi store, the index holds the id under kimi. The union would
    // otherwise REVIVE the corruption — reading the path means handing a
    // kimi transcript to the claude plugin.
    const joined = joinJournalRow(
      record({ title: "probe", transcriptPath: "/.kimi-code/sessions/kimi-9" }),
      { kind: "foreign", agents: ["kimi"] },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(joined.read).toBeNull();
    expect(joined.status).toBe("wrong-owner");
    expect(joined.title).toBe("probe"); // still named by what it honestly knows
  });

  it("absent splits on the scan state: 'indexing' while a scan runs, 'nothing-to-read' only when settled", () => {
    const pathless = record();
    expect(
      joinJournalRow(pathless, { kind: "absent" }, LABEL, true, true).status,
    ).toBe("indexing");
    expect(
      joinJournalRow(pathless, { kind: "absent" }, LABEL, false, true).status,
    ).toBe("nothing-to-read");
  });

  it("no answer yet is the temporary state, never 'nothing-to-read' — the first-paint trap", () => {
    // First render: the scan flag starts OFF and the ask has not fired.
    // Deriving one from the other is exactly the flash the design forbids.
    expect(
      joinJournalRow(record(), undefined, LABEL, false, true).status,
    ).toBe("indexing");
  });

  it("a failed ask is named as itself — for a pathless row it is not 'nothing-to-read'", () => {
    expect(
      joinJournalRow(record(), { kind: "error" }, LABEL, false, true).status,
    ).toBe("index-error");
    // A first refusal before any success must not masquerade as an
    // absence even while the index looks settled.
    expect(
      joinJournalRow(record(), { kind: "error" }, LABEL, true, true).status,
    ).toBe("index-error");
  });

  it("the composite axis: the conversation's last move when the index knows, the journal's mark otherwise", () => {
    // Index-known: mtime IS the last move — even when the pane closed
    // days later (the axis the user chose: the conversation, not the
    // pane).
    const known = joinJournalRow(
      record({ endedAt: "2026-07-19T11:00:00.000Z" }),
      { kind: "hit", reference: "/store/s-1", title: null, mtime: 1_000 },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(known.when).toBe(1_000);
    // Index-unknown: the journal's own mark, not a sink-to-the-end.
    const unknown = joinJournalRow(
      record({ endedAt: "2026-07-19T11:00:00.000Z" }),
      { kind: "absent" },
      LABEL,
      ...SETTLED_SCANNED,
    );
    expect(unknown.when).toBe(Date.parse("2026-07-19T11:00:00.000Z"));
    // Unanswered too — no invented axis, the honest journal mark.
    expect(
      joinJournalRow(record({ endedAt: "2026-07-19T11:00:00.000Z" }), undefined, LABEL, ...SETTLED_SCANNED).when,
    ).toBe(Date.parse("2026-07-19T11:00:00.000Z"));
  });

  it("an empty answer set is not an input here — but empty answers resolve per-row, and the empty journal is the caller's", () => {
    // The join is per-row pure: "empty index" is every entry absent (or
    // unanswered), "empty journal" is zero rows to join — neither needs
    // this function to know about the other.
    const emptyIndexRow = joinJournalRow(record(), { kind: "absent" }, LABEL, false, true);
    expect(emptyIndexRow.status).toBe("nothing-to-read");
    expect(emptyIndexRow.read).toBeNull();
  });
});
