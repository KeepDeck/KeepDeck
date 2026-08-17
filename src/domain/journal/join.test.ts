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

describe("joinJournalRow", () => {
  it("a row without its own name takes the index's title; a meaningful own name keeps it", () => {
    const named = joinJournalRow(
      record({ title: "fix the auth bug" }),
      { kind: "hit", reference: "/store/s-1", title: "index says otherwise" },
      LABEL,
      false,
    );
    expect(named.title).toBe("fix the auth bug");

    const nameless = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: "index title" },
      LABEL,
      false,
    );
    expect(nameless.title).toBe("index title");

    const blank = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: null },
      LABEL,
      false,
    );
    expect(blank.title).toBeUndefined();
  });

  it("a title equal to the agent's LABEL is the frozen fallback, not a name — the index title wins", () => {
    // The two live records literally titled "Claude Code": without this
    // rule the join would keep the label as a title and the complaint
    // stays half-open.
    const joined = joinJournalRow(
      record({ title: LABEL }),
      { kind: "hit", reference: "/store/s-1", title: "the real conversation" },
      LABEL,
      false,
    );
    expect(joined.title).toBe("the real conversation");
    // With no index answer to fall back on, the label-title is simply
    // gone — the caller's fallback chain renders the same label anyway.
    const unanswered = joinJournalRow(record({ title: LABEL }), undefined, LABEL, false);
    expect(unanswered.title).toBeUndefined();
    // No agent info (plugin gone) → no label to compare against; the
    // title stands as the record's own.
    const noLabel = joinJournalRow(record({ title: LABEL }), undefined, undefined, false);
    expect(noLabel.title).toBe(LABEL);
  });

  it("the read link is the UNION: journal path first, the index's reference when the journal has none", () => {
    const both = joinJournalRow(
      record({ transcriptPath: "/journal/s-1.jsonl" }),
      { kind: "hit", reference: "/store/s-1", title: null },
      LABEL,
      false,
    );
    expect(both.read).toEqual({ source: "journal", reference: "/journal/s-1.jsonl" });

    const onlyIndex = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: null },
      LABEL,
      false,
    );
    expect(onlyIndex.read).toEqual({ source: "index", reference: "/store/s-1" });

    const neither = joinJournalRow(record(), { kind: "absent" }, LABEL, false);
    expect(neither.read).toBeNull();
  });

  it("a journal path keeps the row readable against EVERY index answer — failure never degrades the known", () => {
    const answers: (JoinEntry | undefined)[] = [
      undefined,
      { kind: "absent" },
      { kind: "error" },
    ];
    for (const entry of answers) {
      const joined = joinJournalRow(
        record({ transcriptPath: "/journal/s-1.jsonl" }),
        entry,
        LABEL,
        false,
      );
      expect(joined.read).toEqual({ source: "journal", reference: "/journal/s-1.jsonl" });
      expect(joined.status).toBeNull();
    }
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
      false,
    );
    expect(joined.read).toBeNull();
    expect(joined.status).toBe("wrong-owner");
    expect(joined.title).toBe("probe"); // still named by what it honestly knows
  });

  it("absent splits on the scan state: 'indexing' while a scan runs, 'nothing-to-read' only when settled", () => {
    const pathless = record();
    expect(
      joinJournalRow(pathless, { kind: "absent" }, LABEL, true).status,
    ).toBe("indexing");
    expect(
      joinJournalRow(pathless, { kind: "absent" }, LABEL, false).status,
    ).toBe("nothing-to-read");
  });

  it("no answer yet is the temporary state, never 'nothing-to-read' — the first-paint trap", () => {
    // First render: the scan flag starts OFF and the ask has not fired.
    // Deriving one from the other is exactly the flash the design forbids.
    expect(joinJournalRow(record(), undefined, LABEL, false).status).toBe("indexing");
  });

  it("a failed ask is named as itself — for a pathless row it is not 'nothing-to-read'", () => {
    expect(joinJournalRow(record(), { kind: "error" }, LABEL, false).status).toBe(
      "index-error",
    );
    // A first refusal before any success must not masquerade as an
    // absence even while the index looks settled.
    expect(joinJournalRow(record(), { kind: "error" }, LABEL, true).status).toBe(
      "index-error",
    );
  });

  it("a stale hit keeps its read link and title, and says it is last-known", () => {
    const joined = joinJournalRow(
      record(),
      { kind: "hit", reference: "/store/s-1", title: "kept title", stale: true },
      LABEL,
      false,
    );
    expect(joined.read).toEqual({ source: "index", reference: "/store/s-1" });
    expect(joined.title).toBe("kept title");
    expect(joined.status).toBeNull();
    expect(joined.stale).toBe(true);
    // A journal-sourced read is index-independent — never stale-marked.
    const journalRead = joinJournalRow(
      record({ transcriptPath: "/journal/s-1.jsonl" }),
      { kind: "hit", reference: "/store/s-1", title: null, stale: true },
      LABEL,
      false,
    );
    expect(journalRead.stale).toBe(false);
  });

  it("an empty answer set is not an input here — but empty answers resolve per-row, and the empty journal is the caller's", () => {
    // The join is per-row pure: "empty index" is every entry absent (or
    // unanswered), "empty journal" is zero rows to join — neither needs
    // this function to know about the other.
    const emptyIndexRow = joinJournalRow(record(), { kind: "absent" }, LABEL, false);
    expect(emptyIndexRow.status).toBe("nothing-to-read");
    expect(emptyIndexRow.read).toBeNull();
  });
});
