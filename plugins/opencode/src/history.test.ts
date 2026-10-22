import { describe, expect, it, vi } from "vitest";
import { CONTENT_CAP } from "@keepdeck/plugin-api";
import { opencodeHistory, type HistoryPorts } from "./history";

/** One query's answer the way the host gives it now: rows PLUS why the read
 * stopped. Fixtures stay bare arrays — the interesting case, an answer the
 * host's byte budget cut short, is spelled `{ cut: rows }`. */
type Answer = (string | null)[][] | { cut: (string | null)[][] } | Error;

/** The tables of a 1.x store, as the shape query lists them. */
const V1_TABLES = [["session"], ["message"], ["part"]];

/**
 * A host answering the shape question as a 1.x store does, and every other
 * query from `results` in order. The shapes themselves — 2.x, both — are
 * read over a real SQLite in history.sqlite.test.ts; this double is for what
 * only it can stage, the host's budget cut.
 */
function ctx(results: Answer[]) {
  const query = vi.fn(async (_db: string, sql: string, _params?: string[]) => {
    const next = sql.includes("sqlite_master") ? V1_TABLES : results.shift();
    if (next instanceof Error) throw next;
    const budget = next !== undefined && !Array.isArray(next);
    return {
      rows: budget ? next.cut : (next ?? []),
      stopped: budget ? ("budget" as const) : ("exhausted" as const),
      payloadBytes: 0,
    };
  });
  const warn = vi.fn();
  const ports: HistoryPorts = {
    services: { sqlite: { query } },
    log: { info: vi.fn(), warn, error: vi.fn() },
  };
  /** The SQL of every query but the shape one. */
  const asked = () =>
    query.mock.calls.map(([, sql]) => sql).filter((sql) => !sql.includes("sqlite_master"));
  return { ctx: ports, query, asked, warn };
}

describe("opencode history", () => {
  it("fingerprints a session by its own clock AND its newest part", async () => {
    // The session row alone lies: on a real store 1271 of 1967 sessions
    // hold parts newer than the row that speaks for them, so a scanner
    // trusting it SKIPS sessions that changed and the index goes stale.
    const { ctx: c, asked } = ctx([[["ses_1", "1", "1769121238325", "0", "1769200000000"]]]);
    const history = opencodeHistory(c);

    expect(await history.list()).toEqual([
      { sessionId: "ses_1", ref: "ses_1", mtime: 1769121238325, size: 1769200000000 },
    ]);
    expect(asked()[0]).toContain("MAX(p.time_updated)");
  });

  it("a session with no parts fingerprints as zero, not as absent", async () => {
    const { ctx: c } = ctx([[["ses_1", "1", "1769121238325", "0", null]]]);
    expect(await opencodeHistory(c).list()).toEqual([
      { sessionId: "ses_1", ref: "ses_1", mtime: 1769121238325, size: 0 },
    ]);
  });

  it("a missing store lists empty instead of failing the scan", async () => {
    const { ctx: c, query } = ctx([]);
    query.mockRejectedValueOnce(new Error("no such db"));
    expect(await opencodeHistory(c).list()).toEqual([]);
  });

  /**
   * `list()` has no way to say "partial" — a successful return IS the claim
   * that the whole store was seen, and the host prunes on it. So a cut can
   * only be answered by refusing.
   *
   * The empty-store arm makes this easy to get wrong: put the check inside
   * that `catch` and the refusal comes back as `[]`, which is the same lie
   * wearing a shorter list.
   */
  it("the legacy list REFUSES a cut — it has no way to report a partial one", async () => {
    const { ctx: c } = ctx([{ cut: [["ses_1", "1", "1", "0", "2"]] }]);
    await expect(opencodeHistory(c).list()).rejects.toThrow(/cut short/);
  });

  /**
   * The enumeration the host may prune from. `list()`'s successful return
   * has always meant "complete enough to delete what it omits", and that
   * claim stopped being safe the moment the host began cutting answers.
   */
  it("a listing cut by the budget is not complete — the host must not prune from it", async () => {
    const rows = [["ses_1", "1", "1", "0", "2"]];
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
    const { ctx: c, query, warn } = ctx([]);
    query.mockRejectedValueOnce(new Error("no such db"));
    expect(await opencodeHistory(c).listing!()).toEqual({ stubs: [], complete: false });
    expect(warn.mock.calls[0][0]).toContain("no such db");
  });

  it("a database with neither table set is refused, not read as empty", async () => {
    const { ctx: c, query } = ctx([]);
    query.mockResolvedValueOnce({ rows: [["project"]], stopped: "exhausted", payloadBytes: 0 });
    expect(await opencodeHistory(c).listing!()).toEqual({ stubs: [], complete: false });
  });

  /**
   * The page and the corpus are two readings of one session, and they must
   * select the SAME rows in the SAME order, or the two quietly stop
   * matching. So they share one reading.
   *
   * The bound is not among the things they share, because the plugin does
   * not state one: a `LIMIT` in rows is blind to how big a row is. The host
   * bounds the answer in bytes.
   */
  it("reads the same rows in the same order for both readings, and bounds neither", async () => {
    const { ctx: c, asked } = ctx([]);
    const history = opencodeHistory(c);
    await history.content("ses_1");
    const forCorpus = asked();
    await history.transcriptPage!("ses_1", { offset: 0, limit: 10 });

    expect(asked().slice(forCorpus.length)).toEqual(forCorpus);
    const parts = forCorpus.find((sql) => sql.includes("FROM part"))!;
    // Ordered, so the host's cut costs a session its TAIL and not an
    // arbitrary middle — and no row limit of the plugin's own.
    expect(parts).toContain("ORDER BY id");
    expect(forCorpus.join(" ")).not.toMatch(/LIMIT/);
  });

  it("a page cut by the host's budget says how many rows it did get", async () => {
    // The host stops at a byte ceiling and says so; the reader can name what
    // arrived and never what did not — the rest was never read, which is the
    // entire point of the ceiling.
    const { ctx: c } = ctx([[["m1", "user"]], { cut: [["m1", "as much as fit", "1"]] }]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", { offset: 0, limit: 10 });
    expect(page.entries).toEqual([{ role: "user", text: "as much as fit" }]);
    expect(page.shortfall).toEqual([{ kind: "rows", returned: 1 }]);
  });

  it("a cut session row is refused — an empty cwd would enter the index as a fact", async () => {
    const { ctx: c } = ctx([{ cut: [] }]);
    await expect(opencodeHistory(c).describe("ses_1")).rejects.toThrow(/cut short/);
  });

  it("a cut corpus is refused only when it came up short of the cap", async () => {
    // Short of the cap: the cut removed text the index would have held.
    const { ctx: short } = ctx([[["m1", "user"]], { cut: [["m1", "barely anything", "1"]] }]);
    await expect(opencodeHistory(short).content("ses_1")).rejects.toThrow(/cut short/);

    // At the cap: the tail was being dropped anyway, so the cut changed
    // nothing and refusing would cost the index a whole session's text.
    const { ctx: full } = ctx([[["m1", "user"]], { cut: [["m1", "x".repeat(CONTENT_CAP), "1"]] }]);
    expect((await opencodeHistory(full).content("ses_1")).length).toBe(CONTENT_CAP);
  });

  it("asks the database for fields, not the column they sit in", async () => {
    // `message.data` carries whole code diffs; this reading wants one field.
    // The guard is load-bearing: on a torn row an unguarded `json_extract`
    // raises "malformed JSON" and kills the whole query, so a single damaged
    // line would make the session unreadable rather than skipped.
    const { ctx: c, asked } = ctx([[["m1", "user"]], [["m1", "hi", "1"]]]);
    await opencodeHistory(c).transcriptPage!("ses_1", { offset: 0, limit: 10 });

    const sql = asked().find((q) => q.includes("FROM message"))!;
    expect(sql).not.toMatch(/SELECT id, data/);
    expect(sql).toContain("json_extract(data, '$.role')");
    expect(sql).toContain("CASE WHEN json_valid(data)");
    // A tie left open lets two identical queries answer differently, which a
    // paged reader turns into one turn twice and another never.
    expect(sql).toContain("ORDER BY time_created, id");
  });

  it("asks the database for text parts only, and guards both sides", async () => {
    // Text is 27 MB of this store's 608 MB of parts; tool calls alone are
    // 442 MB. The filter belongs where the rows are, not after the bridge.
    const { ctx: c, asked } = ctx([]);
    await opencodeHistory(c).content("ses_1");

    const sql = asked().find((q) => q.includes("FROM part"))!;
    expect(sql).toContain("json_extract(data, '$.type')");
    // Guarded in the FILTER and in the SELECT list: a torn row is let
    // through on purpose, and an unguarded extract would then kill the
    // query on the very row we mean to count.
    expect(sql.match(/CASE WHEN json_valid\(data\)/g)).toHaveLength(2);
    // Let through, not filtered out — that is what keeps the damage count.
    expect(sql).toContain("ELSE 'torn'");
  });

  it("tool calls and thinking are NOT losses — a busy session reports none", async () => {
    // Tool calls and thinking never arrive — the filter drops them in the
    // database. What remains to prove: a whitespace-only text part and an
    // envelope-less row are not losses either.
    const { ctx: c } = ctx([
      [["m1", "assistant"]],
      [
        ["m1", "done", "1"],
        ["m1", "  ", "1"],
        ["m1", "", ""],
      ],
    ]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", { offset: 0, limit: 10 });
    // A mark that cried here would teach the reader to ignore it.
    expect(page.entries).toEqual([{ role: "assistant", text: "done" }]);
    expect(page.shortfall).toBeUndefined();
  });

  it("a clean page carries no shortfall — absence is not an empty one", async () => {
    const { ctx: c } = ctx([[["m1", "user"]], [["m1", "all of it", "1"]]]);
    const page = await opencodeHistory(c).transcriptPage!("ses_1", { offset: 0, limit: 10 });
    expect(page).toEqual({ entries: [{ role: "user", text: "all of it" }] });
  });

  it("the legacy method is the page unpacked — the two cannot disagree", async () => {
    const rows: (string | null)[][][] = [[["m1", "user"]], [["m1", "same either way", "1"]]];
    const viaPage = await opencodeHistory(ctx(rows.map((r) => [...r])).ctx).transcriptPage!(
      "ses_1",
      { offset: 0, limit: 10 },
    );
    const viaLegacy = await opencodeHistory(ctx(rows.map((r) => [...r])).ctx).transcript(
      "ses_1",
      { offset: 0, limit: 10 },
    );
    expect(viaLegacy).toEqual(viaPage.entries);
  });
});
