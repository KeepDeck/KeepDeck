import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { opencodeHistory } from "./history";

/** One query's answer the way the host gives it now: rows PLUS why the read
 * stopped. Fixtures stay bare arrays — the interesting case, an answer the
 * host's byte budget cut short, is spelled `{ cut: rows }`. */
type Answer = (string | null)[][] | { cut: (string | null)[][] } | Error;

function ctx(results: Answer[]) {
  const query = vi.fn(async (..._args: unknown[]) => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    const budget = next !== undefined && !Array.isArray(next);
    return {
      rows: budget ? next.cut : (next ?? []),
      stopped: budget ? "budget" : "exhausted",
      payloadBytes: 0,
    };
  });
  const warn = vi.fn();
  return {
    ctx: {
      services: { sqlite: { query } },
      log: { info: vi.fn(), warn, error: vi.fn() },
    } as unknown as PluginContext,
    query,
    warn,
  };
}

describe("opencode history", () => {
  it("fingerprints a session by its own clock AND its newest part", async () => {
    // The session row alone lies: on a real store 1271 of 1967 sessions
    // hold parts newer than the row that speaks for them, so a scanner
    // trusting it SKIPS sessions that changed and the index goes stale.
    const { ctx: c, query } = ctx([[["ses_1", "1769121238325", "1769200000000"]]]);
    const history = opencodeHistory(c);

    expect(await history.list()).toEqual([
      {
        sessionId: "ses_1",
        ref: "ses_1",
        mtime: 1769121238325,
        size: 1769200000000,
      },
    ]);
    expect(query.mock.calls[0][1]).toContain("time_archived IS NULL");
    expect(query.mock.calls[0][1]).toContain("MAX(p.time_updated)");
  });

  it("a session with no parts fingerprints as zero, not as absent", async () => {
    const { ctx: c } = ctx([[["ses_1", "1769121238325", null]]]);
    expect(await opencodeHistory(c).list()).toEqual([
      { sessionId: "ses_1", ref: "ses_1", mtime: 1769121238325, size: 0 },
    ]);
  });

  it("a missing store lists empty instead of failing the scan", async () => {
    const { ctx: c } = ctx([new Error("no such db")]);
    expect(await opencodeHistory(c).list()).toEqual([]);
  });

  /**
   * The enumeration the host may prune from. `list()`'s successful return
   * has always meant "complete enough to delete what it omits", and that
   * claim stopped being safe the moment the host began cutting answers.
   */
  it("a listing cut by the budget is not complete — the host must not prune from it", async () => {
    const rows = [["ses_1", "1", "2"]];
    const whole = await opencodeHistory(ctx([rows]).ctx).listing!();
    expect(whole).toEqual({
      stubs: [{ sessionId: "ses_1", ref: "ses_1", mtime: 1, size: 2 }],
      complete: true,
    });

    // Same rows, cut: the sessions past the cut are UNSEEN, not deleted.
    const cut = await opencodeHistory(ctx([{ cut: rows }]).ctx).listing!();
    expect(cut.stubs).toEqual(whole.stubs);
    expect(cut.complete).toBe(false);
  });

  it("an unreadable store enumerates nothing INCOMPLETE — not an empty store", async () => {
    // [] with complete:true would read as "every session was deleted" and
    // the prune would wipe this agent's whole index.
    const { ctx: c, warn } = ctx([new Error("no such db")]);
    expect(await opencodeHistory(c).listing!()).toEqual({
      stubs: [],
      complete: false,
    });
    expect(warn.mock.calls[0][0]).toContain("no such db");
  });

  /**
   * Two readers take these rows for different questions — one pages turns and
   * counts what it could not parse, the other pours the text into the search
   * corpus — and they must select the SAME rows in the SAME order, or the two
   * readings of one session quietly stop matching.
   *
   * The bound is no longer among the things they share, because the plugin no
   * longer states one: a `LIMIT` in rows is blind to how big a row is. The
   * host bounds the answer in bytes.
   */
  it("selects the same rows in the same order for both readings, and bounds neither", async () => {
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
    // Ordered, so the host's cut costs a session its TAIL and not an
    // arbitrary middle — and no row limit of the plugin's own.
    expect(bounds[0]).toContain("ORDER BY id");
    expect(bounds[0]).not.toMatch(/LIMIT/);
  });

  it("a page cut by the host's budget says how many rows it did get", async () => {
    // The host stops at a byte ceiling and says so; the reader can name what
    // arrived and never what did not — the rest was never read, which is the
    // entire point of the ceiling.
    const { ctx: c } = ctx([
      [["m1", "user"]],
      { cut: [["m1", "as much as fit", "1"]] },
    ]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", {
      offset: 0,
      limit: 10,
    });
    expect(page.entries).toEqual([{ role: "user", text: "as much as fit" }]);
    expect(page.shortfall).toEqual([{ kind: "rows", returned: 1 }]);
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
