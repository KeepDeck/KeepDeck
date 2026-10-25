import type { PluginSqlite, SqlAnswer } from "@keepdeck/plugin-api";
import { migrationOf, storeShape, type Migration, type StoreShape } from "./historyMerge";

/**
 * opencode's store as the plugin reads it: one SQLite database, read through
 * the `sqliteReadonly` capability, holding the 1.x tables, the 2.x tables or
 * both (historyMerge.ts says which rows win). Every reading asks first which
 * it is, because a 2.x run can add its tables between two readings.
 *
 * Two readers share it: the history (history.ts) and the question a resume
 * or a fork asks before it starts — where one session lives (`locate`).
 *
 * The path is the release builds' (both generations write `opencode.db`
 * there; measured, task-460). A pane under `OPENCODE_DB` or a non-release
 * channel writes elsewhere, and the plugin cannot see the pane's
 * environment — so whatever is read here describes the default store.
 */
const DB = "~/.local/share/opencode/opencode.db";

/** The tables a store's shape is read from. A query the host lets through:
 * it takes SELECT only, no PRAGMA, no WITH. */
const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table'";

/** The 1.x → 2.x copy's progress marker: its phase and when it was written. */
const MIGRATION_MARKER =
  "SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.phase') END," +
  " time_updated FROM kv WHERE key = 'migration.v1-v2'";

/** When each table set last changed one session. The copy to 2.x carries a
 * session's `time_updated` over as it was, and both generations move it on
 * every real change since (2.x: drizzle's `$onUpdate`, read in the v2.1.4
 * source) — so the newer of the two is the one the user went on in. */
const V1_UPDATED = "SELECT time_updated FROM session WHERE id = ?1";
const V2_UPDATED = "SELECT time_updated FROM session_v2 WHERE id = ?1";

/** Where one session lives: its row in each table set, and how far the copy
 * between them got. */
export interface Whereabouts {
  v1?: { updated: number };
  v2?: { updated: number };
  migration: Migration;
}

/** What reading the store needs from the host. */
export interface StorePorts {
  services: { sqlite: PluginSqlite };
}

export const number = (cell: string | null | undefined) => Number(cell ?? 0);

export function opencodeStore(ports: StorePorts) {
  const query = (sql: string, params: string[] = []) =>
    ports.services.sqlite.query(DB, sql, params);

  /** Which table sets the store has, now. */
  const shape = async (): Promise<StoreShape> =>
    storeShape((await query(TABLES)).rows.map(([name]) => name ?? ""));

  const migration = async (now: StoreShape): Promise<Migration> => {
    if (!now.v1 || !now.v2 || !now.kv) return migrationOf(now, undefined);
    const [marker] = (await query(MIGRATION_MARKER)).rows;
    return migrationOf(now, marker ? { phase: marker[0], at: number(marker[1]) } : undefined);
  };

  /** One session's row in one table set, when that set exists and has it. */
  const updated = async (present: boolean, sql: string, id: string) => {
    if (!present) return undefined;
    const answer: SqlAnswer = await query(sql, [id]);
    if (answer.stopped === "budget") throw new Error(`opencode: session row cut short (${id})`);
    const [row] = answer.rows;
    return row ? { updated: number(row[0]) } : undefined;
  };

  return {
    query,
    shape,
    migration,
    /** Where `id` lives. Throws when the store cannot be read. */
    async locate(id: string): Promise<Whereabouts> {
      const now = await shape();
      const [v1, v2, copy] = await Promise.all([
        updated(now.v1, V1_UPDATED, id),
        updated(now.v2, V2_UPDATED, id),
        migration(now),
      ]);
      return { ...(v1 ? { v1 } : {}), ...(v2 ? { v2 } : {}), migration: copy };
    },
  };
}

export type OpencodeStore = ReturnType<typeof opencodeStore>;
