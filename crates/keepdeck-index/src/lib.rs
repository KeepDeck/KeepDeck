//! The session-search index ([F8] global browser): a DISPOSABLE projection
//! of the agents' own stores into SQLite + FTS5, so search-as-you-type over
//! thousands of sessions never touches a plugin.
//!
//! Disposable is the design's load-bearing property: truth stays in the
//! agent stores (and KeepDeck's journal); this file only holds derived
//! data. A schema change bumps [`SCHEMA_VERSION`] and the index is deleted
//! and rebuilt by the next scan — there are NO data migrations, ever, and
//! no backup story. Losing the file costs one re-scan.

use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;

/// Bump on ANY schema change — the opener wipes and recreates. Also the
/// lever for content-derivation fixes (e.g. title heuristics): stamped rows
/// never refresh while their file is unchanged, a rebuild re-derives all.
pub const SCHEMA_VERSION: i64 = 3;

/// One indexed session (an upsert row). `content` is the extracted
/// searchable text (user+assistant turns), plugin-provided.
#[derive(Debug, Clone)]
pub struct IndexRow {
    pub agent: String,
    pub session_id: String,
    /// Opaque per-plugin ref (usually the transcript path) — the diff key.
    pub reference: String,
    pub cwd: String,
    pub title: Option<String>,
    /// The transcript file, when the plugin knows one — carried explicitly
    /// so consumers never have to guess it from the ref's shape.
    pub transcript_path: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub content: String,
}

/// A stored ref + change stamp — what incremental scans diff against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedRef {
    pub reference: String,
    pub mtime: i64,
    pub size: i64,
}

/// One search hit, newest-first within equal rank.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub agent: String,
    pub session_id: String,
    pub reference: String,
    pub cwd: String,
    pub title: Option<String>,
    pub transcript_path: Option<String>,
    pub mtime: i64,
    /// FTS snippet with `[` `]` highlight markers, when content matched.
    pub snippet: Option<String>,
}

pub struct SessionIndex {
    conn: Connection,
}

impl SessionIndex {
    /// Open (or create) the index at `path`. A version mismatch or an
    /// unreadable file wipes and recreates — disposable by contract.
    pub fn open(path: &Path) -> Result<Self, String> {
        match Self::try_open(path) {
            Ok(index) => Ok(index),
            Err(_) => {
                let _ = std::fs::remove_file(path);
                Self::try_open(path)
            }
        }
    }

    fn try_open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version != SCHEMA_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS fts;",
            )
            .map_err(|e| e.to_string())?;
            conn.execute_batch(&format!(
                "CREATE TABLE sessions (
                    agent TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    ref TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    title TEXT,
                    transcript_path TEXT,
                    mtime INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    PRIMARY KEY (agent, session_id)
                );
                CREATE INDEX sessions_by_ref ON sessions(agent, ref);
                CREATE VIRTUAL TABLE fts USING fts5(
                    content, agent UNINDEXED, session_id UNINDEXED
                );
                PRAGMA user_version = {SCHEMA_VERSION};"
            ))
            .map_err(|e| e.to_string())?;
        }
        Ok(Self { conn })
    }

    /// Every stored ref of `agent` — the incremental scan's diff base.
    pub fn refs(&self, agent: &str) -> Result<Vec<IndexedRef>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT ref, mtime, size FROM sessions WHERE agent = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![agent], |r| {
                Ok(IndexedRef { reference: r.get(0)?, mtime: r.get(1)?, size: r.get(2)? })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Insert-or-replace sessions with their searchable content.
    pub fn upsert(&mut self, rows: &[IndexRow]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for row in rows {
            tx.execute(
                "DELETE FROM fts WHERE agent = ?1 AND session_id = ?2",
                params![row.agent, row.session_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO sessions
                 (agent, session_id, ref, cwd, title, transcript_path, mtime, size)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.agent,
                    row.session_id,
                    row.reference,
                    row.cwd,
                    row.title,
                    row.transcript_path,
                    row.mtime,
                    row.size
                ],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO fts (content, agent, session_id) VALUES (?1, ?2, ?3)",
                params![row.content, row.agent, row.session_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Drop sessions of `agent` whose ref is NOT in `live` — gone from the
    /// store (deleted/GC'd by the CLI).
    pub fn prune(&mut self, agent: &str, live: &[String]) -> Result<usize, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let stored: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare("SELECT session_id, ref FROM sessions WHERE agent = ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![agent], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let live: std::collections::HashSet<&str> =
            live.iter().map(String::as_str).collect();
        let mut dropped = 0;
        for (session_id, reference) in stored {
            if live.contains(reference.as_str()) {
                continue;
            }
            tx.execute(
                "DELETE FROM sessions WHERE agent = ?1 AND session_id = ?2",
                params![agent, session_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM fts WHERE agent = ?1 AND session_id = ?2",
                params![agent, session_id],
            )
            .map_err(|e| e.to_string())?;
            dropped += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(dropped)
    }

    /// Search titles + content. An empty query lists everything newest-first
    /// (the browser's initial view). Content matches carry a snippet.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        let q = query.trim();
        if q.is_empty() {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT agent, session_id, ref, cwd, title, transcript_path, mtime
                     FROM sessions ORDER BY mtime DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit as i64], |r| {
                    Ok(SearchHit {
                        agent: r.get(0)?,
                        session_id: r.get(1)?,
                        reference: r.get(2)?,
                        cwd: r.get(3)?,
                        title: r.get(4)?,
                        transcript_path: r.get(5)?,
                        mtime: r.get(6)?,
                        snippet: None,
                    })
                })
                .map_err(|e| e.to_string())?;
            return rows.collect::<Result<_, _>>().map_err(|e| e.to_string());
        }
        // FTS5 prefix query over content, unioned with a LIKE over titles —
        // the user types fragments, not query syntax; quoting kills injection
        // into the MATCH grammar.
        let fts_query = q
            .split_whitespace()
            .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
        // A session matching BOTH branches yields two UNION rows (the snippet
        // column differs), so fetch double and trim to `limit` AFTER the
        // in-Rust dedup — SQL-side LIMIT alone under-fills the page.
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.agent, s.session_id, s.ref, s.cwd, s.title,
                        s.transcript_path, s.mtime,
                        snippet(fts, 0, '[', ']', '…', 12) AS snip
                 FROM fts JOIN sessions s
                   ON s.agent = fts.agent AND s.session_id = fts.session_id
                 WHERE fts MATCH ?1
                 UNION
                 SELECT agent, session_id, ref, cwd, title, transcript_path,
                        mtime, NULL
                 FROM sessions WHERE title LIKE ?2 ESCAPE '\\'
                 ORDER BY mtime DESC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![fts_query, like, (limit * 2) as i64], |r| {
                Ok(SearchHit {
                    agent: r.get(0)?,
                    session_id: r.get(1)?,
                    reference: r.get(2)?,
                    cwd: r.get(3)?,
                    title: r.get(4)?,
                    transcript_path: r.get(5)?,
                    mtime: r.get(6)?,
                    snippet: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut hits: Vec<SearchHit> =
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        // The UNION can yield one row twice (title AND content match) —
        // keep the content hit, it carries the snippet.
        hits.sort_by(|a, b| {
            (&a.agent, &a.session_id, a.snippet.is_none())
                .cmp(&(&b.agent, &b.session_id, b.snippet.is_none()))
        });
        hits.dedup_by(|a, b| a.agent == b.agent && a.session_id == b.session_id);
        hits.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        hits.truncate(limit);
        Ok(hits)
    }
}

/// A read-only, containment-checked query against an AGENT's own SQLite
/// store (the `sqliteReadonly` capability's backend). Parameters are
/// positional strings; the single statement must be a SELECT.
pub fn query_readonly(
    db_path: &Path,
    sql: &str,
    params_in: &[String],
) -> Result<Vec<Vec<Option<String>>>, String> {
    if !sql.trim_start().to_ascii_lowercase().starts_with("select") {
        return Err("only a single SELECT is allowed".into());
    }
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_millis(1500))
        .map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let cols = stmt.column_count();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_in.iter()), |r| {
            let mut out = Vec::with_capacity(cols);
            for i in 0..cols {
                let value: Option<rusqlite::types::Value> = r.get(i)?;
                out.push(value.map(|v| match v {
                    rusqlite::types::Value::Null => String::new(),
                    rusqlite::types::Value::Integer(n) => n.to_string(),
                    rusqlite::types::Value::Real(f) => f.to_string(),
                    rusqlite::types::Value::Text(t) => t,
                    rusqlite::types::Value::Blob(_) => String::from("<blob>"),
                }));
            }
            Ok(out)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(agent: &str, id: &str, mtime: i64, content: &str) -> IndexRow {
        IndexRow {
            agent: agent.into(),
            session_id: id.into(),
            reference: format!("/store/{id}"),
            cwd: "/repo".into(),
            title: Some(format!("title {id}")),
            transcript_path: Some(format!("/store/{id}")),
            mtime,
            size: 10,
            content: content.into(),
        }
    }

    #[test]
    fn double_matching_sessions_do_not_underfill_the_page() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        // Every session matches the query in BOTH title and content.
        let rows: Vec<IndexRow> = (0..6)
            .map(|i| {
                let mut r = row("claude", &format!("s{i}"), i, "shared token here");
                r.title = Some("shared token".into());
                r
            })
            .collect();
        index.upsert(&rows).unwrap();
        let hits = index.search("shared", 5).unwrap();
        assert_eq!(hits.len(), 5); // not ~limit/2
    }

    #[test]
    fn upsert_search_and_snippet() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("index.sqlite")).unwrap();
        index
            .upsert(&[
                row("claude", "a", 2, "the auth bug lives in the token refresh"),
                row("codex", "b", 1, "renamed the workspace rail"),
            ])
            .unwrap();

        let all = index.search("", 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].session_id, "a"); // newest first

        let hits = index.search("token refr", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.as_deref().unwrap().contains("[token]"));

        // Title match without a content match still surfaces.
        let title = index.search("title b", 10).unwrap();
        assert_eq!(title.len(), 1);
        assert_eq!(title[0].session_id, "b");
    }

    #[test]
    fn refs_diff_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        index.upsert(&[row("claude", "a", 1, "x"), row("claude", "b", 1, "y")]).unwrap();
        assert_eq!(index.refs("claude").unwrap().len(), 2);
        assert_eq!(index.refs("codex").unwrap().len(), 0);

        let dropped = index.prune("claude", &["/store/a".into()]).unwrap();
        assert_eq!(dropped, 1);
        assert_eq!(index.search("", 10).unwrap().len(), 1);
    }

    #[test]
    fn version_bump_wipes_and_recreates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("i.sqlite");
        {
            let mut index = SessionIndex::open(&path).unwrap();
            index.upsert(&[row("claude", "a", 1, "x")]).unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA user_version = 999;").unwrap();
        }
        let index = SessionIndex::open(&path).unwrap();
        assert_eq!(index.search("", 10).unwrap().len(), 0); // rebuilt empty
    }

    #[test]
    fn readonly_query_rejects_non_select_and_reads_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("store.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE session (id TEXT, title TEXT);
                 INSERT INTO session VALUES ('s1', 'hello');",
            )
            .unwrap();
        }
        let rows = query_readonly(&db, "SELECT id, title FROM session", &[]).unwrap();
        assert_eq!(rows, vec![vec![Some("s1".into()), Some("hello".into())]]);
        assert!(query_readonly(&db, "DELETE FROM session", &[]).is_err());
    }
}
