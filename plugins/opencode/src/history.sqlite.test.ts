import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { PluginContext } from "@keepdeck/plugin-api";
import { opencodeHistory } from "./history";

/**
 * The queries against a REAL SQLite, over a store with REAL damage in it.
 *
 * Everything else about this plugin is tested through a double that answers
 * rows, which pins the SHAPE of the SQL and can say nothing about what
 * SQLite does with it. That gap is not academic here: the guard these
 * queries are built around exists because `json_extract` on malformed JSON
 * does not answer NULL but RAISES, killing the whole query — a claim about
 * the engine that a mock is structurally unable to make or to break.
 *
 * So this file runs the plugin unmodified, over a database with a torn row
 * in it, and asserts both halves of the reason the guard exists: an
 * unguarded extract dies on that row, and the plugin's spelling does not.
 * That is the assertion a mock cannot make — it is about the engine.
 */

/** opencode's schema, narrowed to the columns these queries read. */
const SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT,
    time_updated INTEGER, time_archived INTEGER
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
    data TEXT, time_updated INTEGER
  );
`;

const text = (t: string) => JSON.stringify({ type: "text", text: t });

/** A store holding one session whose damage is deliberate: one torn part
 * inside an otherwise readable turn, and one torn message envelope. */
function store(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO session VALUES ('ses_1', '/repo', 'a title', 1700, NULL);
    INSERT INTO message VALUES ('m1', 'ses_1', 10, '${JSON.stringify({ role: "user" })}');
    INSERT INTO message VALUES ('m2', 'ses_1', 20, '{"role": "assist');
    INSERT INTO part VALUES ('p1', 'ses_1', 'm1', '${text("first half")}', 1);
    INSERT INTO part VALUES ('p2', 'ses_1', 'm1', '{"type": "te', 2);
    INSERT INTO part VALUES ('p3', 'ses_1', 'm1', '${text("second half")}', 3);
    INSERT INTO part VALUES ('p4', 'ses_1', 'm2', '${text("torn envelope")}', 4);
    INSERT INTO part VALUES ('p5', 'ses_1', 'm1', '${JSON.stringify({ type: "tool" })}', 5);
  `);
  return db;
}

/**
 * The host's own coercion, so the plugin sees what production hands it:
 * SQL NULL arrives as `null`, everything else as its text. (`?1` becomes
 * `?` — the host binds positionally either way.)
 */
function ctxOver(db: DatabaseSync): PluginContext {
  const query = async (_db: string, sql: string, params: string[] = []) => {
    const rows: (string | null)[][] = [];
    for (const row of db.prepare(sql.replace(/\?1/g, "?")).iterate(...params)) {
      rows.push(
        Object.values(row as Record<string, unknown>).map((v) =>
          v === null || v === undefined ? null : String(v),
        ),
      );
    }
    return { rows, stopped: "exhausted" as const, payloadBytes: 0 };
  };
  return {
    services: { sqlite: { query } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as PluginContext;
}

describe("opencode history over a real SQLite", () => {
  it("reads a session whose store holds torn JSON, and counts the damage", async () => {
    const db = store();
    const history = opencodeHistory(ctxOver(db));

    // The whole point: none of these throw. Before the guard, ONE torn row
    // made every one of them fail and the session unreadable entirely.
    expect(await history.describe("ses_1")).toEqual({
      cwd: "/repo",
      title: "a title",
    });
    expect(await history.content("ses_1")).toBe(
      "first half\nsecond half\ntorn envelope",
    );

    const page = await history.transcriptPage!("ses_1", {
      offset: 0,
      limit: 10,
    });
    // The torn PART leaves a hole inside a turn that still looks whole —
    // which is exactly why the count has to travel beside it. The torn
    // MESSAGE keeps its text and loses only its role.
    expect(page.entries).toEqual([
      { role: "user", text: "first half\nsecond half" },
      { role: "other", text: "torn envelope" },
    ]);
    expect(page.shortfall).toEqual([{ kind: "parts", unreadableParts: 1 }]);
    db.close();
  });

  it("an unguarded extract really does die on that same row", async () => {
    const db = store();
    const ask = (sql: string) => () => db.prepare(sql).all();

    // The claim the whole design rests on, made against the engine rather
    // than asserted in a comment: `json_extract` does not answer NULL for
    // malformed JSON, it raises — and it raises from either position, so
    // one torn row would cost the entire session.
    expect(ask("SELECT json_extract(data, '$.type') FROM part")).toThrow(
      /malformed JSON/i,
    );
    expect(
      ask("SELECT 1 FROM part WHERE json_extract(data, '$.type') = 'text'"),
    ).toThrow(/malformed JSON/i);

    // The shape the plugin uses does not, from either position.
    expect(
      ask(
        "SELECT CASE WHEN json_valid(data) THEN json_extract(data, '$.text') END" +
          " FROM part WHERE (CASE WHEN json_valid(data)" +
          " THEN json_extract(data, '$.type') ELSE 'torn' END) IN ('text', 'torn')",
      ),
    ).not.toThrow();

    // NOT asserted here: that `json_valid(x) AND json_extract(x)` raises.
    // It does not, on this engine — SQLite 3.50.4 short-circuits this plan.
    // Its danger is a CONTRACT one: evaluation order of an AND's operands
    // is not promised, and the code generator has a branch that takes the
    // right operand first. A spelling that is safe only while the planner
    // agrees is not a guard, and a test that demanded a raise here would
    // be pinning today's plan rather than the reason.
    db.close();
  });

  it("enumerates the store with the fingerprint the scanner diffs on", async () => {
    const db = store();
    // The second axis comes from the parts, not the session row: here the
    // newest part is at 5 while the session claims 1700.
    expect(await opencodeHistory(ctxOver(db)).listing!()).toEqual({
      stubs: [{ sessionId: "ses_1", ref: "ses_1", mtime: 1700, size: 5 }],
      complete: true,
    });
    db.close();
  });
});
