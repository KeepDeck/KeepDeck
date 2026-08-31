import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { opencodeHistory } from "./history";

function ctx(results: ((string | null)[][] | Error)[]) {
  const query = vi.fn(async (..._args: unknown[]) => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  });
  return {
    ctx: { services: { sqlite: { query } } } as unknown as PluginContext,
    query,
  };
}

describe("opencode history", () => {
  it("lists unarchived sessions with time_updated as the fingerprint", async () => {
    const { ctx: c, query } = ctx([[["ses_1", "1769121238325"]]]);
    const history = opencodeHistory(c);
    expect(await history.list()).toEqual([
      { sessionId: "ses_1", ref: "ses_1", mtime: 1769121238325, size: 0 },
    ]);
    expect(query.mock.calls[0][1]).toContain("time_archived IS NULL");
  });

  it("a missing store lists empty instead of failing the scan", async () => {
    const { ctx: c } = ctx([new Error("no such db")]);
    expect(await opencodeHistory(c).list()).toEqual([]);
  });

  /**
   * Two readers take these rows for different questions — one pages turns and
   * counts what it could not parse, the other pours the text into the search
   * corpus — and the bound they read within used to be written out for each.
   * Raise it in one and the two readings of the same session start disagreeing
   * about where it ends: nothing fails, the answers just stop matching.
   */
  it("bounds both readings of a session the same way", async () => {
    const { ctx: c, query } = ctx([[], [], []]);
    const history = opencodeHistory(c);
    await history.content("ses_1");
    await history.transcriptPage!("ses_1", { offset: 0, limit: 10 });

    const partQueries = query.mock.calls
      .map(([, sql]) => sql as string)
      .filter((sql) => sql.includes("FROM part"));
    expect(partQueries).toHaveLength(2);
    const bounds = partQueries.map((sql) => sql.replace(/^SELECT .*? FROM/, "FROM"));
    expect(new Set(bounds).size).toBe(1);
    // And it is a real bound, not two matching absences.
    expect(bounds[0]).toMatch(/ORDER BY id LIMIT \d+/);
  });

  it("content keeps only text parts; transcript groups parts per message", async () => {
    // The database now answers with the extracted text, not the envelope:
    // non-text parts never reach the plugin at all.
    const { ctx: c } = ctx([
      [["hello"], ["world"]],
      [
        ["m1", "user"],
        ["m2", "assistant"],
      ],
      [
        ["m1", "hello", "1"],
        ["m2", "world", "1"],
      ],
    ]);
    const history = opencodeHistory(c);
    expect(await history.content("ses_1")).toBe("hello\nworld");
    expect(await history.transcript("ses_1", { offset: 0, limit: 10 })).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
  });

  it("asks the database for the role, not the column it sits in", async () => {
    // `message.data` carries whole code diffs; this reading wants one field.
    // The guard is load-bearing: on a torn row an unguarded `json_extract`
    // raises "malformed JSON" and kills the whole query, so a single damaged
    // line would make the session unreadable rather than skipped.
    const { ctx: c, query } = ctx([[["m1", "user"]], [["m1", "hi", "1"]]]);
    await opencodeHistory(c).transcriptPage!("ses_1", { offset: 0, limit: 10 });

    const sql = query.mock.calls.find(([, q]) =>
      (q as string).includes("FROM message"),
    )![1] as string;
    expect(sql).not.toMatch(/SELECT id, data/);
    expect(sql).toContain("json_extract(data, '$.role')");
    expect(sql).toContain("CASE WHEN json_valid(data)");
    // A tie left open lets two identical queries answer differently, which a
    // paged reader turns into one turn twice and another never.
    expect(sql).toContain("ORDER BY time_created, id");
  });

  it("a message whose envelope did not parse reads as an unnamed role", async () => {
    // What the guard produces for a torn row: a NULL role. It must land on
    // "other", exactly as an unparseable envelope did before.
    const { ctx: c } = ctx([
      [["m1", null]],
      [["m1", "orphaned", "1"]],
    ]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", {
      offset: 0,
      limit: 10,
    });
    expect(page.entries).toEqual([{ role: "other", text: "orphaned" }]);
  });

  it("asks the database for text parts only, and guards both sides", async () => {
    // Text is 27 MB of this store's 608 MB of parts; tool calls alone are
    // 442 MB. The filter belongs where the rows are, not after the bridge.
    const { ctx: c, query } = ctx([[], []]);
    await opencodeHistory(c).content("ses_1");

    const sql = query.mock.calls[0][1] as string;
    expect(sql).toContain("json_extract(data, '$.type')");
    // Guarded in the FILTER and in the SELECT list: a torn row is let
    // through on purpose, and an unguarded extract would then kill the
    // query on the very row we mean to count.
    expect(sql.match(/CASE WHEN json_valid\(data\)/g)).toHaveLength(2);
    // Let through, not filtered out — that is what keeps the damage count.
    expect(sql).toContain("ELSE 'torn'");
  });

  it("a page names the parts it could not read — a hole inside a shown turn", async () => {
    // A torn row reaches the plugin as an empty text and a zero — its
    // content stays in the database, its existence does not.
    const { ctx: c } = ctx([
      [["m1", "user"]],
      [
        ["m1", "first half", "1"],
        ["m1", "", "0"],
        ["m1", "second half", "1"],
      ],
    ]);
    const history = opencodeHistory(c);
    const page = await history.transcriptPage!("ses_1", {
      offset: 0,
      limit: 10,
    });
    // The turn LOOKS whole — the gap is invisible in its text, which is
    // exactly why the count has to travel beside it.
    expect(page.entries).toEqual([
      { role: "user", text: "first half\nsecond half" },
    ]);
    expect(page.shortfall).toEqual([{ kind: "parts", unreadableParts: 1 }]);
  });

  it("tool calls and thinking are NOT losses — a busy session reports none", async () => {
    // Tool calls and thinking never arrive now — the filter drops them in
    // the database. What remains to prove: a whitespace-only text part and
    // an envelope-less row are not losses either.
    const { ctx: c } = ctx([
      [["m1", "assistant"]],
      [
        ["m1", "done", "1"],
        ["m1", "  ", "1"],
        ["m1", "", ""],
      ],
    ]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", {
      offset: 0,
      limit: 10,
    });
    // Four of the five parts yielded no text, and NONE of them was lost —
    // a mark that cried here would teach the reader to ignore it.
    expect(page.entries).toEqual([{ role: "assistant", text: "done" }]);
    expect(page.shortfall).toBeUndefined();
  });

  it("a clean page carries no shortfall — absence is not an empty one", async () => {
    const { ctx: c } = ctx([
      [["m1", "user"]],
      [["m1", "all of it", "1"]],
    ]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", {
      offset: 0,
      limit: 10,
    });
    expect(page).toEqual({ entries: [{ role: "user", text: "all of it" }] });
  });

  it("the legacy method is the page unpacked — the two cannot disagree", async () => {
    const rows: (string | null)[][][] = [
      [["m1", "user"]],
      [["m1", "same either way", "1"]],
    ];
    const viaPage = await opencodeHistory(
      ctx(rows.map((r) => [...r])).ctx,
    ).transcriptPage!("ses_1", { offset: 0, limit: 10 });
    const viaLegacy = await opencodeHistory(
      ctx(rows.map((r) => [...r])).ctx,
    ).transcript("ses_1", { offset: 0, limit: 10 });
    expect(viaLegacy).toEqual(viaPage.entries);
  });
});
