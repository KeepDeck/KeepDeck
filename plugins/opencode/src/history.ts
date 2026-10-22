import {
  CONTENT_CAP,
  sessionHistory,
  titleText,
  transcriptRole,
  type AgentHistory,
  type PluginLogger,
  type PluginSqlite,
  type SqlAnswer,
} from "@keepdeck/plugin-api";
import {
  mergeSessions,
  mergeTurns,
  migrationOf,
  storeShape,
  transcriptOf,
  type Migration,
  type StoreShape,
  type Turn,
  type V1Session,
  type V2Session,
} from "./historyMerge";

/**
 * Discovery over opencode's store ([F8] browser): everything lives in one
 * SQLite database. Read via the `sqliteReadonly` capability (a binary blob is
 * useless to `fs`); the query text lives HERE because the schema knowledge is
 * this plugin's.
 *
 * The database holds 1.x tables, 2.x tables, or both (historyMerge.ts says
 * which rows win); every reading asks first which it is, because a 2.x run
 * can add its tables between two readings.
 */
const DB = "~/.local/share/opencode/opencode.db";

/** The tables a store's shape is read from. A query the host lets through:
 * it takes SELECT only, no PRAGMA, no WITH. */
const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table'";

/** The 1.x → 2.x copy's progress marker: its phase and when it was written. */
const MIGRATION_MARKER =
  "SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.phase') END," +
  " time_updated FROM kv WHERE key = 'migration.v1-v2'";

/**
 * The text-carrying parts of one 1.x session, in order, and whether each row
 * survived being written.
 *
 * NO ROW LIMIT HERE. There used to be one, and it was the plugin guessing at
 * a resource question it cannot see: a cap in rows is blind to how big a row
 * is, so it bounded nothing that mattered and every reader of these rows had
 * to remember the same number. The host bounds the answer in BYTES now, and
 * says so in `stopped` — one bound, enforced where the bytes actually are,
 * that no plugin can drift out of step with.
 *
 * THE TYPE FILTER RUNS IN THE DATABASE. Text is 27 MB of this store's 608 MB
 * of parts; tool calls alone are 442 MB. Carrying every type across the
 * bridge to discard nineteen twentieths of it on arrival was the same
 * mistake as selecting a whole column to read one field.
 *
 * THE GUARDS ARE LOAD-BEARING, in the filter AND in the select list. On a
 * torn row `json_extract` does not answer NULL — it raises "malformed JSON"
 * and kills the whole query, which would make one damaged line cost an
 * entire session. `CASE` is what guarantees the check runs first: SQLite's
 * code generator may evaluate an `AND`'s right operand first, so the
 * familiar `json_valid(x) AND json_extract(x)` spelling is luck.
 *
 * A TORN ROW IS LET THROUGH ON PURPOSE. `ELSE 'torn'` keeps it in the
 * answer, where it arrives as three tiny cells — its id, an empty text and
 * a zero — carrying none of its content. That is what preserves the damage
 * count without a second query: filtering the row out in the database would
 * have silently retired the one mark that explains a hole inside a turn the
 * reader can see.
 *
 * `id`, not `time_created`: real sessions share ONE timestamp across
 * thousands of parts, so the client-minted, sortable ids are the only
 * chronological key there is. One known store quirk rides along harmlessly —
 * a synthetic `prt_0000000000_thinking` sentinel sorts before its session's
 * first real part, but it is not a text part and the filter drops it.
 *
 * The order is also what makes the host's cut survivable: cut at the end of
 * an ordered read, a session loses its tail. Unordered, it would lose an
 * arbitrary middle and never say which.
 */
const V1_TEXT_PARTS =
  "SELECT message_id, CASE WHEN json_valid(data) THEN json_extract(data, '$.text') END," +
  " json_valid(data)" +
  " FROM part WHERE session_id = ?1" +
  " AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.type')" +
  " ELSE 'torn' END) IN ('text', 'torn')" +
  " ORDER BY id";

/**
 * A 1.x session's messages: id, role, and — for a compaction's summary — the
 * compaction message it answers (see historyMerge.ts mergeTurns).
 *
 * FIELDS, not the column they sit in. `message.data` carries
 * `summary.diffs` — whole code diffs — and this reading wants the role.
 * Selecting the column dragged 440 MB across the bridge for a session whose
 * roles are twelve kilobytes; held as UTF-16 in the webview that is most of
 * a gigabyte for one click. A user message's `summary` is that diff object;
 * only an assistant's is the boolean `true`, hence `json_type`.
 *
 * `, id` is the tiebreaker: messages share a `time_created`, and an ORDER BY
 * that leaves the tie open may answer two identical queries differently —
 * which a paged reader turns into one turn shown twice and another never.
 */
const V1_MESSAGES =
  "SELECT id, CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END," +
  " CASE WHEN json_valid(data) THEN CASE WHEN json_type(data, '$.summary') = 'true'" +
  " THEN json_extract(data, '$.parentID') END END" +
  " FROM message WHERE session_id = ?1 ORDER BY time_created, id";

/** An object item of a 2.x assistant's `content`, `{}` for anything else, so
 * the extracts below cannot raise on a scalar. */
const CONTENT_ITEM = "(CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END)";

/**
 * A 2.x session's messages in order: id, type, readable text, and whether
 * the row parsed.
 *
 * The text, per type (packages/schema/src/session-message.ts at v2.1.2):
 * - `user`, `synthetic` — `text`. Synthetic is context the harness added,
 *   KeepDeck's own mail among it; 1.x showed it inside the user's turn.
 * - `assistant` — the `text` items of `content`, joined; reasoning and tool
 *   calls stay out, as they do for 1.x.
 * - `compaction` — its `summary`, or a failed one's error. 1.x showed the
 *   summary as an assistant message.
 * - the rest (`system`, `skill`, `shell`, `idle`, the switches) carry no
 *   conversation and read as empty.
 *
 * Extracted HERE, not in the plugin: an assistant row carries its tool
 * calls and their output, and only the text is wanted. The same guards as
 * 1.x — CASE before every extract — and an assistant whose `content` is not
 * an array counts as unreadable rather than as silent.
 */
const V2_MESSAGES =
  "SELECT id, type," +
  " CASE WHEN NOT json_valid(data) THEN NULL" +
  " WHEN type IN ('user', 'synthetic') THEN" +
  " CASE WHEN json_type(data, '$.text') = 'text' THEN json_extract(data, '$.text') END" +
  " WHEN type = 'assistant' THEN" +
  " CASE WHEN json_type(data, '$.content') = 'array' THEN" +
  ` (SELECT group_concat(json_extract(${CONTENT_ITEM}, '$.text'), char(10))` +
  " FROM json_each(data, '$.content') j" +
  ` WHERE json_extract(${CONTENT_ITEM}, '$.type') = 'text'` +
  ` AND json_type(${CONTENT_ITEM}, '$.text') = 'text') END` +
  " WHEN type = 'compaction' THEN" +
  " CASE WHEN json_type(data, '$.summary') = 'text' THEN json_extract(data, '$.summary')" +
  " WHEN json_type(data, '$.error.message') = 'text' THEN json_extract(data, '$.error.message') END" +
  " END," +
  " CASE WHEN NOT json_valid(data) THEN 0" +
  " WHEN type = 'assistant' AND json_type(data, '$.content') IS NOT 'array' THEN 0" +
  " ELSE 1 END" +
  " FROM session_message WHERE session_id = ?1 ORDER BY seq";

/**
 * Every 1.x session, with the two-part fingerprint the scanner diffs on.
 *
 * The session row's own timestamp is NOT a change fingerprint. On a real
 * store 1271 of 1967 sessions hold parts newer than the row that is
 * supposed to speak for them: the content moved and the row did not. A
 * scanner trusting it SKIPS sessions that changed, and the index goes
 * quietly stale — a worse failure than re-reading too often, because the
 * answer it shows is merely old and says nothing.
 *
 * The newest part's timestamp is the second axis. Not a count: half this
 * store's parts were edited in place after being written, and a count is
 * blind to every one of them. Not a sum of lengths either: that reads
 * 608 MB of blobs on every listing AND still misses an edit that kept its
 * length.
 *
 * It is also the whole cost of the listing: seven seconds on a real 10 GB
 * store, against a millisecond for the 2.x tables. So it is read only for
 * sessions 1.x touched after the copy to 2.x (`?1`, -1 when there was none):
 * the rest are frozen, and 2.x already holds them. The one miss: a 1.x turn
 * already under way when the copy finished writes parts without touching
 * the session again; its next prompt does.
 */
const V1_SESSIONS =
  "SELECT s.id, s.time_created, s.time_updated, s.time_archived IS NOT NULL," +
  " CASE WHEN s.time_updated > ?1" +
  " THEN (SELECT MAX(p.time_updated) FROM part p WHERE p.session_id = s.id) END" +
  " FROM session s";

/** Every 2.x session, with its event counter as the second axis: it moves
 * on every durable change — a message streamed, a title, an archive — where
 * `session_message.time_updated` is never bumped after insert. */
const V2_SESSIONS =
  "SELECT s.id, s.time_updated, s.time_archived IS NOT NULL, e.seq" +
  " FROM session_v2 s LEFT JOIN event_sequence e ON e.aggregate_id = s.id";

const V1_SESSION = "SELECT directory, title FROM session WHERE id = ?1";
const V2_SESSION = "SELECT directory, title FROM session_v2 WHERE id = ?1";

type Rows = SqlAnswer["rows"];

const number = (cell: string | null | undefined) => Number(cell ?? 0);

const v1Sessions = (rows: Rows): V1Session[] =>
  rows.flatMap(([id, created, updated, archived, partMax]) =>
    id
      ? [
          {
            id,
            created: number(created),
            updated: number(updated),
            archived: archived === "1",
            partMax: number(partMax),
          },
        ]
      : [],
  );

const v2Sessions = (rows: Rows): V2Session[] =>
  rows.flatMap(([id, updated, archived, seq]) =>
    id ? [{ id, updated: number(updated), archived: archived === "1", seq: number(seq) }] : [],
  );

/**
 * A 1.x session's turns: its messages, each with the text of its parts.
 *
 * A part row that will not PARSE is a real loss and countable right here —
 * no extra query, no total to know: the text of a shown turn simply has a
 * hole in it, and a hole inside a visible turn is the one shortfall a reader
 * would otherwise blame on the agent.
 *
 * Only the parse failure counts, and STRICTLY a zero. A null text has three
 * very different reasons — torn JSON, a part with no text to give, an empty
 * string — and the last two are the store working normally; a row whose data
 * is SQL NULL answers neither 0 nor 1, and an empty envelope is not a
 * damaged one. A mark that cries on healthy data is worse than no mark,
 * because it teaches the reader to ignore it.
 *
 * A torn message envelope keeps its text and loses only its role.
 */
function v1Turns(messages: Rows, parts: Rows): Turn[] {
  const texts = new Map<string, string[]>();
  const torn = new Map<string, number>();
  for (const [messageId, text, intact] of parts) {
    if (!messageId) continue;
    if (intact === "0") {
      torn.set(messageId, (torn.get(messageId) ?? 0) + 1);
      continue;
    }
    const said = text?.trim();
    if (!said) continue;
    texts.set(messageId, [...(texts.get(messageId) ?? []), said]);
  }
  return messages.flatMap(([id, role, summarizes]) =>
    id
      ? [
          {
            id,
            role: transcriptRole(role),
            text: (texts.get(id) ?? []).join("\n"),
            unreadable: torn.get(id) ?? 0,
            ...(summarizes ? { summarizes } : {}),
          },
        ]
      : [],
  );
}

const v2Turns = (rows: Rows): Turn[] =>
  rows.flatMap(([id, type, text, intact]) =>
    id
      ? [{ id, role: transcriptRole(type), text: text?.trim() ?? "", unreadable: intact === "0" ? 1 : 0 }]
      : [],
  );

/** What the history reads through: the host's SQL and its log. */
export interface HistoryPorts {
  services: { sqlite: PluginSqlite };
  log: PluginLogger;
}

export function opencodeHistory(ctx: HistoryPorts): AgentHistory {
  const query = (sql: string, params: string[] = []) =>
    ctx.services.sqlite.query(DB, sql, params);
  const none: SqlAnswer = { rows: [], stopped: "exhausted", payloadBytes: 0 };

  /** The store's shape, now. A database with neither table set is not a
   * store this plugin can read — a refusal, never an empty store. */
  const shapeNow = async (): Promise<StoreShape> => {
    const shape = storeShape((await query(TABLES)).rows.map(([name]) => name ?? ""));
    if (!shape.v1 && !shape.v2) throw new Error("opencode: neither the 1.x nor the 2.x session tables are all in the store");
    return shape;
  };

  const migrationNow = async (shape: StoreShape): Promise<Migration> => {
    if (!shape.v1 || !shape.v2 || !shape.kv) return migrationOf(shape, undefined);
    const [marker] = (await query(MIGRATION_MARKER)).rows;
    return migrationOf(shape, marker ? { phase: marker[0], at: number(marker[1]) } : undefined);
  };

  /** The host's stop, translated into the reader's vocabulary. It knows only
   * that more existed, never how much: a budget cut cannot name a total, and
   * the second query that would find one is exactly the cost the budget
   * refused. Silence here would be worse than an imprecise number — a page
   * cut in the middle is indistinguishable from a conversation that ended. */
  const cutShort = (answer: SqlAnswer) =>
    answer.stopped === "budget" ? [{ kind: "rows" as const, returned: answer.rows.length }] : [];

  /** Every turn of one session, from whichever tables hold it, and the
   * answers the host cut. */
  const readTurns = async (ref: string) => {
    const shape = await shapeNow();
    const v2 = shape.v2 ? await query(V2_MESSAGES, [ref]) : none;
    const messages = shape.v1 ? await query(V1_MESSAGES, [ref]) : none;
    const parts = shape.v1 ? await query(V1_TEXT_PARTS, [ref]) : none;
    return {
      turns: mergeTurns(v2Turns(v2.rows), v1Turns(messages.rows, parts.rows)),
      cut: [v2, messages, parts].flatMap(cutShort),
    };
  };

  /** One page of turns WITH what the reading fell short by: the rows that
   * would not parse, and the host's cut — which says how many rows arrived
   * and never how many did not, because the budget's whole point is that the
   * rest was not read. */
  const readPage = async (ref: string, page: { offset: number; limit: number }) => {
    const { turns, cut } = await readTurns(ref);
    const { entries, unreadable } = transcriptOf(turns);
    const shortfall = [
      ...(unreadable > 0 ? [{ kind: "parts" as const, unreadableParts: unreadable }] : []),
      ...cut,
    ];
    return {
      entries: entries.slice(page.offset, page.offset + page.limit),
      ...(shortfall.length > 0 ? { shortfall } : {}),
    };
  };

  return sessionHistory("opencode", ctx.log, {
    /** A store that will not open throws — no store, or an unreadable one.
     * A listing the host CUT is a part not read: the sessions past the cut
     * are unseen, not gone. So is a copy to 2.x still under way: its 2.x
     * half is not all there yet. */
    async enumerate(unreadable) {
      const shape = await shapeNow();
      const migration = await migrationNow(shape);
      const since = migration.state === "completed" ? String(migration.at) : "-1";
      const v1 = shape.v1 ? await query(V1_SESSIONS, [since]) : none;
      const v2 = shape.v2 ? await query(V2_SESSIONS) : none;
      if (v1.stopped === "budget" || v2.stopped === "budget") {
        unreadable("the session list (cut short by the host's read budget)");
      }
      if (migration.state === "pending") {
        unreadable("the 2.x tables (opencode's copy of 1.x sessions has not finished)");
      }
      return mergeSessions(v1Sessions(v1.rows), v2Sessions(v2.rows), migration);
    },
    /** The 2.x row first: a copied session is renamed and moved there. A cut
     * here is not a short answer, it is NO answer: one row was asked for and
     * the budget stopped before it. Neither is a missing row. Reading on
     * would put `cwd: ""` in the index as a FACT about this session;
     * refusing costs the session this pass — the scan logs it skipped and
     * prunes nothing — and it is read again next time. */
    async describe(ref) {
      const shape = await shapeNow();
      for (const sql of [shape.v2 && V2_SESSION, shape.v1 && V1_SESSION]) {
        if (!sql) continue;
        const answer = await query(sql, [ref]);
        if (answer.stopped === "budget") {
          throw new Error(`opencode: session row cut short (${ref})`);
        }
        const [row] = answer.rows;
        if (!row) continue;
        const [directory, title] = row;
        return {
          cwd: directory ?? "",
          ...(title ? { title: titleText(title) } : {}),
        };
      }
      throw new Error(`opencode: no session row (${ref})`);
    },
    async content(ref) {
      // The corpus bound is the CORE's, not this plugin's: how much text one
      // session may contribute to the index is a property of the index, and
      // the file-backed agents already answer to that same number. A local
      // copy of it would only be a second place to change.
      const { turns, cut } = await readTurns(ref);
      const texts: string[] = [];
      let total = 0;
      for (const { text } of transcriptOf(turns).entries) {
        texts.push(text);
        total += text.length;
        if (total >= CONTENT_CAP) break;
      }
      // A cut matters here ONLY if the corpus came up short of the cap.
      // Reaching the cap means the tail was being dropped anyway and the
      // cut changed nothing. Refusing on every cut would trade a slightly
      // shorter corpus for NO corpus — the session would leave the index
      // entirely, which is the worse of the two silences.
      if (cut.length > 0 && total < CONTENT_CAP) {
        throw new Error(`opencode: corpus cut short below the cap (${ref})`);
      }
      return texts.join("\n");
    },
    readPage,
  });
}
