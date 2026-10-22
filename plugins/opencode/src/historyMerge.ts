import type { AgentSessionStub, AgentTranscriptEntry } from "@keepdeck/plugin-api";

/**
 * What opencode's store holds, and which of it is the truth.
 *
 * opencode 2.x moved sessions into new tables (`session_v2`,
 * `session_message`) in the SAME database, and copied the 1.x ones over once
 * (packages/core/src/v1-migration.bun.ts at v2.1.2). The 1.x tables stay,
 * and a 1.x binary keeps writing only them. So one store can hold three
 * shapes — 1.x only, 2.x only, both — and the reader must answer the same
 * way for each. The rules for "both" live here, on plain values; the SQL
 * that fetches the values lives in history.ts.
 */

type Role = AgentTranscriptEntry["role"];

/** Which of the two table sets the store has. */
export interface StoreShape {
  v1: boolean;
  v2: boolean;
  /** Where the migration keeps its progress marker. */
  kv: boolean;
}

/**
 * The shape, from the store's table names.
 *
 * `session_message` alone is not 2.x: 1.19.3 creates it too, empty, beside
 * its own tables. `session_v2` is what only 2.x makes.
 */
export function storeShape(tables: readonly string[]): StoreShape {
  const has = (...names: string[]) => names.every((name) => tables.includes(name));
  return {
    v1: has("session", "message", "part"),
    v2: has("session_v2", "session_message", "event_sequence"),
    kv: has("kv"),
  };
}

/**
 * How far the 1.x → 2.x copy got, for a store holding both table sets.
 *
 * `none` — one table set: nothing to reconcile. A fresh 2.x store has no
 * marker at all and is complete.
 * `completed` — the copy finished `at` (ms). Every 1.x session that existed
 * then is in the 2.x tables, or was deleted there since.
 * `pending` — the copy has not finished (it runs in the background of a 2.x
 * process, one session per transaction), or never wrote its marker.
 */
export type Migration =
  | { state: "none" }
  | { state: "completed"; at: number }
  | { state: "pending" };

/** The migration state from its `kv` marker: `{phase: "sessions" | "completed"}`
 * and the row's `time_updated`. */
export function migrationOf(
  shape: StoreShape,
  marker: { phase: string | null; at: number } | undefined,
): Migration {
  if (!shape.v1 || !shape.v2) return { state: "none" };
  return marker?.phase === "completed" && Number.isFinite(marker.at)
    ? { state: "completed", at: marker.at }
    : { state: "pending" };
}

/** A 1.x session row. `partMax` is its newest part's time, 0 when it was not
 * read (see history.ts: only sessions 1.x touched after the copy need it). */
export interface V1Session {
  id: string;
  created: number;
  updated: number;
  archived: boolean;
  partMax: number;
}

/** A 2.x session row. `seq` is its event counter, which every durable change
 * of the session moves — a message, a title, an archive. */
export interface V2Session {
  id: string;
  updated: number;
  archived: boolean;
  seq: number;
}

/**
 * The store's live sessions, one stub each.
 *
 * - An id in the 2.x tables is decided there, archived included: 2.x is
 *   what the user works in after the copy. (The cost: a 1.x rename or archive
 *   of a copied session does not show — 1.x does not timestamp either, so
 *   there is no newer-wins to apply.)
 * - An id only in the 1.x tables is a session 1.x made after the copy, or one
 *   2.x DELETED. Only the copy's time tells them apart: kept if created after
 *   it. Kept always while the copy is pending — its 2.x half is not there yet.
 * - The fingerprint must move whichever side changed: the newer clock of the
 *   two, and the 1.x part time plus the 2.x event counter. Both only grow in
 *   normal use, so their sum moves when either does.
 */
export function mergeSessions(
  v1: readonly V1Session[],
  v2: readonly V2Session[],
  migration: Migration,
): AgentSessionStub[] {
  const v1ById = new Map(v1.map((session) => [session.id, session]));
  const inV2 = new Set(v2.map((session) => session.id));
  const stub = (id: string, mtime: number, size: number): AgentSessionStub => ({
    sessionId: id,
    ref: id,
    mtime,
    size,
  });
  const cutoff = migration.state === "completed" ? migration.at : undefined;
  const fromV2 = v2
    .filter((session) => !session.archived)
    .map((session) => {
      const old = v1ById.get(session.id);
      return stub(
        session.id,
        Math.max(session.updated, old?.updated ?? 0),
        (old?.partMax ?? 0) + session.seq,
      );
    });
  const fromV1 = v1
    .filter(
      (session) =>
        !session.archived &&
        !inV2.has(session.id) &&
        (cutoff === undefined || session.created > cutoff),
    )
    .map((session) => stub(session.id, session.updated, session.partMax));
  return [...fromV2, ...fromV1];
}

/** One message of a session, as either table set gives it. */
export interface Turn {
  id: string;
  role: Role;
  /** Its readable text, empty when it has none. */
  text: string;
  /** Rows of it that could not be parsed — a hole the text cannot show. */
  unreadable: number;
  /** For a 1.x compaction summary: the compaction message it answers. */
  summarizes?: string;
}

/**
 * A session's turns, the 2.x ones first in their order, then the 1.x ones
 * the copy does not hold.
 *
 * The copy keeps message ids, so an id in both is the same message and 2.x
 * has it. One 1.x message has no 2.x row of its own: a compaction's summary,
 * which the copy folds into the compaction row (keyed by the compaction
 * message's id). Appending it would show that summary twice.
 */
export function mergeTurns(v2: readonly Turn[], v1: readonly Turn[]): Turn[] {
  const inV2 = new Set(v2.map((turn) => turn.id));
  const onlyV1 = v1.filter(
    (turn) => !inV2.has(turn.id) && !(turn.summarizes && inV2.has(turn.summarizes)),
  );
  return [...v2, ...onlyV1];
}

/** The turns a reader sees, and the rows the reading could not parse. */
export function transcriptOf(turns: readonly Turn[]): {
  entries: AgentTranscriptEntry[];
  unreadable: number;
} {
  return {
    entries: turns
      .filter((turn) => turn.text.length > 0)
      .map((turn) => ({ role: turn.role, text: turn.text })),
    unreadable: turns.reduce((sum, turn) => sum + turn.unreadable, 0),
  };
}

/** A transcript role from a message's role or 2.x type. */
export const roleOf = (kind: string | null): Role =>
  kind === "user" || kind === "assistant" ? kind : "other";
