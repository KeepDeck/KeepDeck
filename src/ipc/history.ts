import { invoke } from "@tauri-apps/api/core";

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

export function indexPrune(agent: string, live: string[]): Promise<number> {
  return invoke("index_prune", { agent, live });
}

export function indexSearch(query: string, limit: number): Promise<SearchHit[]> {
  return invoke("index_search", { query, limit });
}

/** The `sqliteReadonly` capability's backend (containment-checked in Rust). */
export function pluginsSqliteQuery(
  dbPath: string,
  sql: string,
  params: string[],
  roots: readonly string[],
): Promise<(string | null)[][]> {
  return invoke("plugins_sqlite_query", { dbPath, sql, params, roots });
}
