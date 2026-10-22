import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { opencodeHistory, type HistoryPorts } from "./history";

/**
 * The queries against a REAL SQLite, over stores with REAL damage in them,
 * in each shape opencode leaves behind: 1.x tables, 2.x tables, both.
 *
 * Everything else about this plugin is tested through a double that answers
 * rows, which pins the SHAPE of the SQL and can say nothing about what
 * SQLite does with it. That gap is not academic here: the guard these
 * queries are built around exists because `json_extract` on malformed JSON
 * does not answer NULL but RAISES, killing the whole query — a claim about
 * the engine that a mock is structurally unable to make or to break. And
 * which rows a query returns from which tables is the whole of the 1.x/2.x
 * merge.
 */

/** opencode 1.x's schema, narrowed to the columns these queries read. */
const V1_SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
    data TEXT, time_updated INTEGER
  );
  -- 1.19.3 makes this one too, empty: it is not the 2.x store.
  CREATE TABLE session_message (id TEXT PRIMARY KEY);
`;

/** opencode 2.x's (v2.1.2), narrowed the same way. */
const V2_SCHEMA = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER
  );
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  CREATE TABLE kv (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  );
`;

const json = (value: unknown) => `'${JSON.stringify(value)}'`;
const text = (t: string) => json({ type: "text", text: t });

/** The moment the copy to 2.x finished, in the stores that hold both. */
const COPIED = 5000;

function open(...schema: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const sql of schema) db.exec(sql);
  return db;
}

/** A 1.x store holding one session whose damage is deliberate: one torn
 * part inside an otherwise readable turn, and one torn message envelope. */
function v1Store(): DatabaseSync {
  const db = open(V1_SCHEMA);
  db.exec(`
    INSERT INTO session VALUES ('ses_1', '/repo', 'a title', 100, 1700, NULL);
    INSERT INTO message VALUES ('m1', 'ses_1', 10, ${json({ role: "user" })});
    INSERT INTO message VALUES ('m2', 'ses_1', 20, '{"role": "assist');
    INSERT INTO part VALUES ('p1', 'ses_1', 'm1', ${text("first half")}, 1);
    INSERT INTO part VALUES ('p2', 'ses_1', 'm1', '{"type": "te', 2);
    INSERT INTO part VALUES ('p3', 'ses_1', 'm1', ${text("second half")}, 3);
    INSERT INTO part VALUES ('p4', 'ses_1', 'm2', ${text("torn envelope")}, 4);
    INSERT INTO part VALUES ('p5', 'ses_1', 'm1', ${json({ type: "tool" })}, 5);
  `);
  return db;
}

/**
 * Both table sets, the way a 2.x run leaves a 1.x store, with one session of
 * each kind the merge must tell apart:
 * - `ses_copied` — copied to 2.x, then continued there (a message, a rename);
 * - `ses_deleted` — copied, then deleted in 2.x; its 1.x rows remain;
 * - `ses_later_v1` — made by 1.x after the copy;
 * - `ses_later_v2` — made by 2.x after the copy.
 */
function bothStore(phase = "completed"): DatabaseSync {
  const db = open(V1_SCHEMA.replace(/CREATE TABLE session_message[^;]*;/, ""), V2_SCHEMA);
  db.exec(`
    INSERT INTO kv VALUES ('migration.v1-v2', ${json({ phase })}, 1, ${COPIED});

    INSERT INTO session VALUES ('ses_copied', '/old', 'old title', 100, 1000, NULL);
    INSERT INTO message VALUES ('m_u', 'ses_copied', 10, ${json({ role: "user" })});
    INSERT INTO message VALUES ('m_a', 'ses_copied', 20, ${json({ role: "assistant" })});
    INSERT INTO message VALUES ('m_c', 'ses_copied', 30, ${json({ role: "user" })});
    INSERT INTO message VALUES ('m_sum', 'ses_copied', 40,
      ${json({ role: "assistant", summary: true, parentID: "m_c" })});
    INSERT INTO part VALUES ('p_u', 'ses_copied', 'm_u', ${text("question")}, 900);
    INSERT INTO part VALUES ('p_a', 'ses_copied', 'm_a', ${text("answer in 1.x")}, 950);
    INSERT INTO part VALUES ('p_c', 'ses_copied', 'm_c', ${json({ type: "compaction" })}, 960);
    INSERT INTO part VALUES ('p_sum', 'ses_copied', 'm_sum', ${text("the summary")}, 970);

    INSERT INTO session VALUES ('ses_deleted', '/gone', 'deleted in 2.x', 200, 1200, NULL);
    INSERT INTO session VALUES ('ses_later_v1', '/v1', 'from 1.x', 6000, 6100, NULL);
    INSERT INTO message VALUES ('m_l', 'ses_later_v1', 10, ${json({ role: "user" })});
    INSERT INTO part VALUES ('p_l', 'ses_later_v1', 'm_l', ${text("1.x again")}, 6200);

    INSERT INTO session_v2 VALUES ('ses_copied', '/new', 'renamed in 2.x', 100, 7000, NULL);
    INSERT INTO session_v2 VALUES ('ses_later_v2', '/v2', 'from 2.x', 8000, 8100, NULL);
    INSERT INTO event_sequence VALUES ('ses_copied', 4);
    INSERT INTO event_sequence VALUES ('ses_later_v2', 2);

    -- What the copy made of ses_copied: the ids kept, the compaction folded
    -- into one row under the compaction message's id, the summary inside it.
    INSERT INTO session_message VALUES ('m_u', 'ses_copied', 'user', 0, ${json({ text: "question" })});
    INSERT INTO session_message VALUES ('m_a', 'ses_copied', 'assistant', 1,
      ${json({ content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "answer in 1.x" }] })});
    INSERT INTO session_message VALUES ('m_c', 'ses_copied', 'compaction', 2,
      ${json({ status: "completed", summary: "the summary" })});
    INSERT INTO session_message VALUES ('m_v2', 'ses_copied', 'synthetic', 3, ${json({ text: "mail from KeepDeck" })});
    INSERT INTO session_message VALUES ('m_tool', 'ses_copied', 'assistant', 4,
      ${json({ content: [{ type: "tool", state: { status: "completed" } }, { type: "text", text: "done in 2.x" }] })});
  `);
  return db;
}

/**
 * The host's own coercion, so the plugin sees what production hands it:
 * SQL NULL arrives as `null`, everything else as its text, and parameters
 * are bound as text. (`?1` becomes `?` — the host binds positionally.)
 */
function portsOver(db: DatabaseSync): HistoryPorts {
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
  };
}

const byId = (stubs: { sessionId: string }[]) =>
  [...stubs].sort((a, b) => a.sessionId.localeCompare(b.sessionId));

describe("opencode history over a real 1.x store", () => {
  it("reads a session whose store holds torn JSON, and counts the damage", async () => {
    const db = v1Store();
    const history = opencodeHistory(portsOver(db));

    // The whole point: none of these throw. Before the guard, ONE torn row
    // made every one of them fail and the session unreadable entirely.
    expect(await history.describe("ses_1")).toEqual({ cwd: "/repo", title: "a title" });
    expect(await history.content("ses_1")).toBe("first half\nsecond half\ntorn envelope");

    const page = await history.transcriptPage!("ses_1", { offset: 0, limit: 10 });
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
    const db = v1Store();
    const ask = (sql: string) => () => db.prepare(sql).all();

    // The claim the whole design rests on, made against the engine rather
    // than asserted in a comment: `json_extract` does not answer NULL for
    // malformed JSON, it raises — and it raises from either position, so
    // one torn row would cost the entire session.
    expect(ask("SELECT json_extract(data, '$.type') FROM part")).toThrow(/malformed JSON/i);
    expect(ask("SELECT 1 FROM part WHERE json_extract(data, '$.type') = 'text'")).toThrow(
      /malformed JSON/i,
    );

    // The shape the plugin uses does not, from either position.
    expect(
      ask(
        "SELECT CASE WHEN json_valid(data) THEN json_extract(data, '$.text') END" +
          " FROM part WHERE (CASE WHEN json_valid(data)" +
          " THEN json_extract(data, '$.type') ELSE 'torn' END) IN ('text', 'torn')",
      ),
    ).not.toThrow();

    // NOT asserted here: that `json_valid(x) AND json_extract(x)` raises.
    // It does not, on this engine — SQLite short-circuits this plan. Its
    // danger is a CONTRACT one: evaluation order of an AND's operands is not
    // promised, and the code generator has a branch that takes the right
    // operand first. A spelling that is safe only while the planner agrees
    // is not a guard, and a test that demanded a raise here would be pinning
    // today's plan rather than the reason.
    db.close();
  });

  it("enumerates the store with the fingerprint the scanner diffs on, complete", async () => {
    // The second axis comes from the parts, not the session row: here the
    // newest part is at 5 while the session claims 1700. With no copy to
    // 2.x in the store, every session's parts are read, and the 1.x
    // `session_message` decoy does not make it a 2.x store.
    const db = v1Store();
    expect(await opencodeHistory(portsOver(db)).listing!()).toEqual({
      stubs: [{ sessionId: "ses_1", ref: "ses_1", mtime: 1700, size: 5 }],
      complete: true,
    });
    db.close();
  });

  it("refuses a session it has no row for — an empty cwd is not a fact", async () => {
    const db = v1Store();
    await expect(opencodeHistory(portsOver(db)).describe("ses_none")).rejects.toThrow(
      /no session row/,
    );
    db.close();
  });
});

describe("opencode history over a real 2.x store", () => {
  it("an empty one is a complete empty store, not an unreadable one", async () => {
    // A fresh 2.x install: tables, no rows, no migration marker. Read with
    // 1.x queries it failed on "no such table" and never pruned again.
    const db = open(V2_SCHEMA);
    expect(await opencodeHistory(portsOver(db)).listing!()).toEqual({
      stubs: [],
      complete: true,
    });
    db.close();
  });

  it("reads its sessions, pages and corpus without the 1.x tables", async () => {
    const db = open(V2_SCHEMA);
    db.exec(`
      INSERT INTO session_v2 VALUES ('ses_2', '/repo', 'two', 1, 4000, NULL);
      INSERT INTO session_v2 VALUES ('ses_gone', '/repo', 'archived', 1, 4000, 4500);
      INSERT INTO event_sequence VALUES ('ses_2', 10);
      INSERT INTO session_message VALUES ('a', 'ses_2', 'user', 0, ${json({ text: "hi" })});
      INSERT INTO session_message VALUES ('b', 'ses_2', 'assistant', 1, '{"content": [{"type": "te');
      INSERT INTO session_message VALUES ('c', 'ses_2', 'assistant', 2, ${json({ content: "not a list" })});
      INSERT INTO session_message VALUES ('d', 'ses_2', 'compaction', 3,
        ${json({ status: "failed", error: { message: "too long" } })});
      INSERT INTO session_message VALUES ('e', 'ses_2', 'idle', 4, ${json({ outcome: "succeeded" })});
      INSERT INTO session_message VALUES ('f', 'ses_2', 'assistant', 5,
        ${json({ content: [{ type: "text", text: "one" }, 7, { type: "text", text: "two" }] })});
    `);
    const history = opencodeHistory(portsOver(db));

    expect(await history.listing!()).toEqual({
      stubs: [{ sessionId: "ses_2", ref: "ses_2", mtime: 4000, size: 10 }],
      complete: true,
    });
    expect(await history.describe("ses_2")).toEqual({ cwd: "/repo", title: "two" });
    // A torn row and a wrong-shaped assistant are both losses the reader is
    // told of; an idle marker has no text and is not one.
    expect(await history.transcriptPage!("ses_2", { offset: 0, limit: 10 })).toEqual({
      entries: [
        { role: "user", text: "hi" },
        { role: "other", text: "too long" },
        { role: "assistant", text: "one\ntwo" },
      ],
      shortfall: [{ kind: "parts", unreadableParts: 2 }],
    });
    expect(await history.content("ses_2")).toBe("hi\ntoo long\none\ntwo");
    db.close();
  });
});

describe("opencode history over a store holding both", () => {
  it("lists each session once, from the side that has the truth", async () => {
    const db = bothStore();
    const listing = await opencodeHistory(portsOver(db)).listing!();

    expect(listing.complete).toBe(true);
    expect(byId(listing.stubs)).toEqual([
      // Copied and continued in 2.x: the newer clock; its 1.x parts were not
      // touched after the copy, so only the 2.x counter speaks.
      { sessionId: "ses_copied", ref: "ses_copied", mtime: 7000, size: 4 },
      // Made by 1.x after the copy: its parts are read.
      { sessionId: "ses_later_v1", ref: "ses_later_v1", mtime: 6100, size: 6200 },
      { sessionId: "ses_later_v2", ref: "ses_later_v2", mtime: 8100, size: 2 },
      // ses_deleted is NOT here: deleted in 2.x, its 1.x copy must not
      // bring it back.
    ]);
    db.close();
  });

  it("reads a 1.x part edit on a copied session that 1.x continued", async () => {
    const db = bothStore();
    db.exec(`
      UPDATE session SET time_updated = 9000 WHERE id = 'ses_copied';
      INSERT INTO message VALUES ('m_more', 'ses_copied', 50, ${json({ role: "user" })});
      INSERT INTO part VALUES ('p_more', 'ses_copied', 'm_more', ${text("back in 1.x")}, 9100);
    `);
    const history = opencodeHistory(portsOver(db));

    const stubs = (await history.listing!()).stubs;
    expect(stubs.find((stub) => stub.sessionId === "ses_copied")).toEqual({
      sessionId: "ses_copied",
      ref: "ses_copied",
      mtime: 9000,
      size: 9100 + 4,
    });
    const page = await history.transcriptPage!("ses_copied", { offset: 0, limit: 10 });
    expect(page.entries[page.entries.length - 1]).toEqual({ role: "user", text: "back in 1.x" });
    db.close();
  });

  it("keeps the 1.x sessions and says the list is partial while the copy runs", async () => {
    // Mid-copy, the 2.x tables hold only part of the sessions: every 1.x one
    // stays, and the host must not prune on this list.
    const db = bothStore("sessions");
    const listing = await opencodeHistory(portsOver(db)).listing!();

    expect(listing.complete).toBe(false);
    expect(listing.stubs.map((stub) => stub.sessionId).sort()).toEqual([
      "ses_copied",
      "ses_deleted",
      "ses_later_v1",
      "ses_later_v2",
    ]);
    db.close();
  });

  it("hides a session archived in 2.x even though 1.x never archived it", async () => {
    const db = bothStore();
    db.exec("UPDATE session_v2 SET time_archived = 7500 WHERE id = 'ses_copied'");
    const stubs = (await opencodeHistory(portsOver(db)).listing!()).stubs;
    expect(stubs.map((stub) => stub.sessionId)).not.toContain("ses_copied");
    db.close();
  });

  it("describes a copied session as 2.x has it, and a 1.x-only one from 1.x", async () => {
    const db = bothStore();
    const history = opencodeHistory(portsOver(db));
    expect(await history.describe("ses_copied")).toEqual({ cwd: "/new", title: "renamed in 2.x" });
    expect(await history.describe("ses_later_v1")).toEqual({ cwd: "/v1", title: "from 1.x" });
    db.close();
  });

  it("shows a copied conversation once — the compaction summary included", async () => {
    // The copy folds 1.x's summary message into its compaction row; without
    // the rule that drops it, the summary would show twice.
    const db = bothStore();
    const page = await opencodeHistory(portsOver(db)).transcriptPage!("ses_copied", {
      offset: 0,
      limit: 10,
    });
    expect(page).toEqual({
      entries: [
        { role: "user", text: "question" },
        { role: "assistant", text: "answer in 1.x" },
        { role: "other", text: "the summary" },
        { role: "other", text: "mail from KeepDeck" },
        { role: "assistant", text: "done in 2.x" },
      ],
    });
    db.close();
  });

  it("pages over the merged conversation, not over one side of it", async () => {
    const db = bothStore();
    const page = await opencodeHistory(portsOver(db)).transcriptPage!("ses_copied", {
      offset: 3,
      limit: 1,
    });
    expect(page.entries).toEqual([{ role: "other", text: "mail from KeepDeck" }]);
    db.close();
  });
});
