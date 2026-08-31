import { invoke } from "@tauri-apps/api/core";
import type { SqlAnswer } from "@keepdeck/plugin-api";

/**
 * The session-search index ([F8] global browser) — a disposable SQLite+FTS5
 * projection at `<keepdeck_home>/index.sqlite`. Discovery and parsing happen
 * in the agent plugins; these commands move normalized rows in and hits out,
 * so search-as-you-type never touches a plugin.
 */

/** A stored ref + change stamp — the incremental scan's diff base. */
export interface IndexedRef {
  reference: string;
  mtime: number;
  size: number;
}

/** One row a scan upserts (plugin-normalized). */
export interface IndexRowInput {
  sessionId: string;
  reference: string;
  cwd: string;
  title?: string | null;
  transcriptPath?: string | null;
  mtime: number;
  size: number;
  content: string;
}

/** One search hit, newest first. */
export interface SearchHit {
  agent: string;
  sessionId: string;
  reference: string;
  cwd: string;
  title: string | null;
  transcriptPath: string | null;
  mtime: number;
  /** FTS snippet with [ ] highlight markers, when content matched. */
  snippet: string | null;
}

export function indexRefs(agent: string): Promise<IndexedRef[]> {
  return invoke("index_refs", { agent });
}

export function indexUpsert(agent: string, rows: IndexRowInput[]): Promise<void> {
  return invoke("index_upsert", { agent, rows });
}

/** A session the prune DROPPED — the key whose cached answers are stale
 * from this moment. */
export interface PrunedKey {
  agent: string;
  sessionId: string;
}

export function indexPrune(agent: string, live: string[]): Promise<PrunedKey[]> {
  return invoke("index_prune", { agent, live });
}

/** One page of hits plus the full match count ("shown X of N"). */
export interface SearchPage {
  hits: SearchHit[];
  total: number;
}

/** Directory membership carried IN a search: the workspace block asks
 * `only`, the global block `except`. Exact cwd paths both ways — the
 * workspace-directory rule lives in the webview's domain. */
export type IndexFolderScope =
  | { mode: "only"; dirs: string[] }
  | { mode: "except"; dirs: string[] };

export function indexSearch(
  query: string,
  limit: number,
  offset: number,
  agent?: string,
  folders?: IndexFolderScope,
): Promise<SearchPage> {
  return invoke("index_search", {
    query,
    limit,
    offset,
    agent: agent ?? null,
    folders: folders ?? null,
  });
}

/** One (agent, session_id) join key — the journal row's targeted ask. */
export interface IndexLookupKey {
  agent: string;
  sessionId: string;
}

/** One keyed lookup answer: the question it answers rides WITH it, so
 * belonging never depends on order or count. The key is the ASKED pair
 * (in `foreign`, deliberately not the agent that was found — that is the
 * branch's whole point). `absent` is absence BY KEY. Narrows on `status`:
 * `reference`/`mtime` exist ONLY on a hit — reading them outside the
 * branch does not compile. `title` on a hit is present-and-nullable
 * (an honest "no title"), a different thing from absent. */
export type IndexLookupAnswer = IndexLookupKey & (
  | { status: "hit"; reference: string; title: string | null; mtime: number }
  | { status: "foreign"; agents: string[] }
  | { status: "absent" }
);

/** Answer (agent, session_id) keys exactly — hits by key, never by
 * enumerating the table; every answer carries its own key, duplicates
 * are a contract violation and refuse loudly. */
export function indexLookup(keys: IndexLookupKey[]): Promise<IndexLookupAnswer[]> {
  return invoke("index_lookup", { keys });
}

/** The `sqliteReadonly` capability's backend (containment-checked in Rust). */
export function pluginsSqliteQuery(
  dbPath: string,
  sql: string,
  params: string[],
  roots: readonly string[],
): Promise<SqlAnswer> {
  return invoke("plugins_sqlite_query", { dbPath, sql, params, roots });
}
