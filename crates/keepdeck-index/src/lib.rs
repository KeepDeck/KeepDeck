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
pub const SCHEMA_VERSION: i64 = 5;

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

/// Directory-based membership, carried IN the query itself: the sessions
/// browser's top block asks for the workspace's folders (`Only`), the
/// bottom block asks for everything but them (`Except`). Exact paths both
/// ways — the workspace-directory rule lives in the webview's domain; to
/// this crate a folder is an opaque cwd string.
#[derive(Debug, Clone)]
pub enum FolderScope {
    Only(Vec<String>),
    Except(Vec<String>),
}

impl FolderScope {
    fn dirs(&self) -> &[String] {
        match self {
            FolderScope::Only(dirs) | FolderScope::Except(dirs) => dirs,
        }
    }

    fn is_except(&self) -> bool {
        matches!(self, FolderScope::Except(_))
    }

    /// The SQL fragment for one table alias (`prefix` empty, or `s.` in the
    /// FTS arm). Returns the clause and how many bind values it owns,
    /// numbered from `first`. `Except` with NO folders is no clause at all
    /// (nothing is excluded); `Only` with NO folders matches nothing —
    /// unreachable from a real workspace (its own folder is always in the
    /// set), and `1=0` keeps that honest if a caller ever sends it.
    fn clause(&self, prefix: &str, first: usize) -> (String, usize) {
        let dirs = self.dirs();
        if dirs.is_empty() {
            return if self.is_except() {
                (String::new(), 0)
            } else {
                (" AND 1=0".to_string(), 0)
            };
        }
        let placeholders = (0..dirs.len())
            .map(|i| format!("?{}", first + i))
            .collect::<Vec<_>>()
            .join(", ");
        let op = if self.is_except() { "NOT IN" } else { "IN" };
        (format!(" AND {prefix}cwd {op} ({placeholders})"), dirs.len())
    }
}

pub struct SessionIndex {
    conn: Connection,
}

/// One answer to a targeted (agent, session_id) lookup — the journal row's
/// join key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookupKind {
    /// The exact row: its read handle (the plugin's opaque ref), title,
    /// and the store's last-activity stamp.
    Hit {
        reference: String,
        title: Option<String>,
        mtime: i64,
    },
    /// The id exists under DIFFERENT agent(s) than asked — the signature
    /// of a journal record whose agent attribution is wrong.
    Foreign { agents: Vec<String> },
    /// No row under any agent carries the id.
    Absent,
}

/// A keyed lookup answer: the question it answers rides WITH the answer,
/// so belonging never depends on order or count. The key is the ASKED
/// one — in the `Foreign` branch deliberately NOT the agent that was
/// found (that is the branch's whole point).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyedAnswer {
    pub agent: String,
    pub session_id: String,
    pub kind: LookupKind,
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
                CREATE INDEX sessions_by_sid ON sessions(session_id);
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
    /// store (deleted/GC'd by the CLI). Returns the (agent, session_id)
    /// keys it dropped: the caller's caches hold per-key answers that a
    /// disappearance INVALIDATES, and this is the only place that knows
    /// which keys those are.
    pub fn prune(
        &mut self,
        agent: &str,
        live: &[String],
    ) -> Result<Vec<(String, String)>, String> {
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
        let mut dropped: Vec<(String, String)> = Vec::new();
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
            // The dropped KEY, for the callers' per-key caches: an
            // (agent, id) answer that says "hit" is stale from this
            // moment, and only this place learned it.
            dropped.push((agent.to_string(), session_id));
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(dropped)
    }

    /// How many sessions match — the "shown X of N" denominator. Same
    /// matching as [`search`] (agent filter, folder scope, FTS ∪
    /// title-LIKE), no paging: the counter and the page come from ONE
    /// query shape, or the count would describe a different set.
    pub fn search_total(
        &self,
        query: &str,
        agent: Option<&str>,
        folders: Option<&FolderScope>,
    ) -> Result<i64, String> {
        use rusqlite::types::Value as SqlValue;
        let q = query.trim();
        let agent_clause = if agent.is_some() { " AND agent = ?A" } else { "" };
        if q.is_empty() {
            // The folder bind values follow the agent's (when present) —
            // numbered right after whatever came before, or SQLite counts
            // a gap the values cannot fill.
            let folder_first = 1 + usize::from(agent.is_some());
            let folder_sql = match folders {
                Some(scope) => scope.clause("", folder_first).0,
                None => String::new(),
            };
            let sql = format!(
                "SELECT COUNT(*) FROM sessions WHERE 1=1{}{}",
                agent_clause.replace("?A", "?1"),
                folder_sql,
            );
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let mut values: Vec<SqlValue> = Vec::new();
            if let Some(a) = agent {
                values.push(SqlValue::Text(a.to_string()));
            }
            if let Some(scope) = folders {
                values.extend(scope.dirs().iter().cloned().map(SqlValue::Text));
            }
            let total = stmt
                .query_row(rusqlite::params_from_iter(values), |r| r.get(0))
                .map_err(|e| e.to_string())?;
            return Ok(total);
        }
        let (fts_query, like) = Self::match_terms(q);
        let folder_first = 3 + usize::from(agent.is_some());
        let folder_sql_s = match folders {
            Some(scope) => scope.clause("s.", folder_first).0,
            None => String::new(),
        };
        let folder_sql = match folders {
            Some(scope) => scope.clause("", folder_first).0,
            None => String::new(),
        };
        let sql = format!(
            "SELECT COUNT(*) FROM (
                SELECT s.agent, s.session_id FROM fts JOIN sessions s
                  ON s.agent = fts.agent AND s.session_id = fts.session_id
                WHERE fts MATCH ?1{a1}{f1}
                UNION
                SELECT agent, session_id FROM sessions
                WHERE title LIKE ?2 ESCAPE '\\'{a2}{f2}
             )",
            a1 = agent_clause.replace("?A", "?3").replace("agent =", "s.agent ="),
            a2 = agent_clause.replace("?A", "?3"),
            f1 = folder_sql_s,
            f2 = folder_sql,
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut values: Vec<SqlValue> =
            vec![SqlValue::Text(fts_query), SqlValue::Text(like)];
        if let Some(a) = agent {
            values.push(SqlValue::Text(a.to_string()));
        }
        if let Some(scope) = folders {
            values.extend(scope.dirs().iter().cloned().map(SqlValue::Text));
        }
        let total = stmt
            .query_row(rusqlite::params_from_iter(values), |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok(total)
    }

    fn match_terms(q: &str) -> (String, String) {
        let fts_query = q
            .split_whitespace()
            .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
        (fts_query, like)
    }

    /// Search titles + content, one page at a time. An empty query lists
    /// everything newest-first (the browser's initial view); `offset` pages
    /// through the FULL match set (no cap — paging replaced the old
    /// truncation); `agent` narrows to one CLI's sessions (the spawn-dialog
    /// picker); `folders` carries directory membership INTO the query (the
    /// top block's `Only`, the bottom's `Except`) so pages arrive already
    /// sorted by block and nothing is fetched to be thrown away. Content
    /// matches carry a snippet.
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
        agent: Option<&str>,
        folders: Option<&FolderScope>,
    ) -> Result<Vec<SearchHit>, String> {
        use rusqlite::types::Value as SqlValue;
        let q = query.trim();
        let agent_clause = if agent.is_some() { " AND agent = ?A" } else { "" };
        if q.is_empty() {
            // Bind values in index order: limit, offset, agent (when
            // present), then the folders — the clause numbers itself right
            // after whichever came last.
            let folder_first = 3 + usize::from(agent.is_some());
            let folder_sql = match folders {
                Some(scope) => scope.clause("", folder_first).0,
                None => String::new(),
            };
            let sql = format!(
                "SELECT agent, session_id, ref, cwd, title, transcript_path, mtime
                 FROM sessions WHERE 1=1{}{}
                 ORDER BY mtime DESC LIMIT ?1 OFFSET ?2",
                agent_clause.replace("?A", "?3"),
                folder_sql,
            );
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let map = |r: &rusqlite::Row<'_>| {
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
            };
            let mut values: Vec<SqlValue> = vec![
                SqlValue::Integer(limit as i64),
                SqlValue::Integer(offset as i64),
            ];
            if let Some(a) = agent {
                values.push(SqlValue::Text(a.to_string()));
            }
            if let Some(scope) = folders {
                values.extend(scope.dirs().iter().cloned().map(SqlValue::Text));
            }
            let rows = stmt
                .query_map(rusqlite::params_from_iter(values), map)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>();
            return rows.map_err(|e| e.to_string());
        }
        // FTS5 prefix query over content, unioned with a LIKE over titles —
        // the user types fragments, not query syntax; quoting kills injection
        // into the MATCH grammar. The UNION would emit a double-matching
        // session twice (differing snippet column), so pagination dedups in
        // SQL: group by session, keep MAX(snip) (the non-NULL content hit),
        // then page with LIMIT/OFFSET over the deduped set. The folder
        // clause guards BOTH arms — a content hit in a foreign folder is as
        // foreign as a title one; the folder bind values are shared by
        // number (?6..) across the arms.
        let (fts_query, like) = Self::match_terms(q);
        let folder_first = 5 + usize::from(agent.is_some());
        let folder_sql_s = match folders {
            Some(scope) => scope.clause("s.", folder_first).0,
            None => String::new(),
        };
        let folder_sql = match folders {
            Some(scope) => scope.clause("", folder_first).0,
            None => String::new(),
        };
        let sql = format!(
            "SELECT agent, session_id, ref, cwd, title, transcript_path,
                    mtime, MAX(snip) AS snippet
             FROM (
                SELECT s.agent, s.session_id, s.ref, s.cwd, s.title,
                       s.transcript_path, s.mtime,
                       snippet(fts, 0, '[', ']', '…', 12) AS snip
                FROM fts JOIN sessions s
                  ON s.agent = fts.agent AND s.session_id = fts.session_id
                WHERE fts MATCH ?1{a1}{f1}
                UNION
                SELECT agent, session_id, ref, cwd, title, transcript_path,
                       mtime, NULL
                FROM sessions WHERE title LIKE ?2 ESCAPE '\\'{a2}{f2}
             )
             GROUP BY agent, session_id
             ORDER BY mtime DESC LIMIT ?3 OFFSET ?4",
            a1 = agent_clause.replace("?A", "?5").replace("agent =", "s.agent ="),
            a2 = agent_clause.replace("?A", "?5"),
            f1 = folder_sql_s,
            f2 = folder_sql,
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row<'_>| {
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
        };
        let mut values: Vec<SqlValue> = vec![
            SqlValue::Text(fts_query),
            SqlValue::Text(like),
            SqlValue::Integer(limit as i64),
            SqlValue::Integer(offset as i64),
        ];
        if let Some(a) = agent {
            values.push(SqlValue::Text(a.to_string()));
        }
        if let Some(scope) = folders {
            values.extend(scope.dirs().iter().cloned().map(SqlValue::Text));
        }
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), map)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>();
        rows.map_err(|e| e.to_string())
    }

    /// Answer each (agent, session_id) key EXACTLY — the journal join's
    /// targeted ask. One query restricted to the requested ids (never an
    /// enumeration of the table); an id found under other agents is the
    /// `Foreign` kind, the recorded-ownership-is-wrong signature. Every
    /// answer CARRIES ITS OWN KEY — belonging never depends on order or
    /// count, and duplicates are rejected by contract (one question, one
    /// truth; a by-key consumer must never face two).
    ///
    /// LOAD-BEARING FORM: the seek is by `session_id` ALONE (over the
    /// `sessions_by_sid` secondary index), never by the primary
    /// (agent, session_id) pair — a corrupted record's agent is exactly
    /// the field that is WRONG, so a primary-pair seek would never see
    /// the true holder and `Foreign` could never fire. That rewrite
    /// looks like an optimization and fails QUIETLY in the hit paths;
    /// the Foreign assertions in this crate's tests are what makes it
    /// loud. The index is not an accelerator for this query — it is
    /// what keeps the only correct query form off a full table scan.
    pub fn lookup(&self, keys: &[(String, String)]) -> Result<Vec<KeyedAnswer>, String> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        // One key, one question: duplicates would be two answers for one
        // by-key consumer fold. The error names the caller, not the data.
        {
            use std::collections::HashSet;
            let mut seen = HashSet::with_capacity(keys.len());
            for (agent, session_id) in keys {
                if !seen.insert((agent.as_str(), session_id.as_str())) {
                    return Err(format!("duplicate lookup key: ({agent}, {session_id})"));
                }
            }
        }
        // One IN over the DISTINCT ids — a key set spans agents (one
        // workspace's journal holds several CLIs' rows), so the pair
        // can't be sought in a single statement. See the doc comment:
        // seeking by session_id alone is the Foreign branch's
        // correctness condition, not a batching convenience.
        let mut ids: Vec<&str> = Vec::with_capacity(keys.len());
        for (_, session_id) in keys {
            if !ids.contains(&session_id.as_str()) {
                ids.push(session_id);
            }
        }
        let placeholders = ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT agent, session_id, ref, title, mtime FROM sessions
             WHERE session_id IN ({placeholders})"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // Both views of the answer: the exact (agent, id) row, and which
        // agents hold an id at all.
        use std::collections::HashMap;
        let mut exact: HashMap<(&str, &str), (&str, Option<&str>, i64)> = HashMap::new();
        let mut holders: HashMap<&str, Vec<&str>> = HashMap::new();
        for (agent, session_id, reference, title, mtime) in &rows {
            exact.insert(
                (agent.as_str(), session_id.as_str()),
                (reference.as_str(), title.as_deref(), *mtime),
            );
            holders.entry(session_id.as_str()).or_default().push(agent.as_str());
        }
        Ok(keys
            .iter()
            .map(|(agent, session_id)| {
                let kind = match exact.get(&(agent.as_str(), session_id.as_str())) {
                    Some((reference, title, mtime)) => LookupKind::Hit {
                        reference: reference.to_string(),
                        title: title.map(str::to_string),
                        mtime: *mtime,
                    },
                    None => match holders.get(session_id.as_str()) {
                        // The requester's own agent, if present, was matched by
                        // the exact arm above; whatever remains is foreign.
                        Some(agents) => LookupKind::Foreign {
                            agents: agents.iter().map(|a| a.to_string()).collect(),
                        },
                        None => LookupKind::Absent,
                    },
                };
                // The key rides WITH its answer — the asked pair, not the
                // found one (Foreign's whole point).
                KeyedAnswer {
                    agent: agent.clone(),
                    session_id: session_id.clone(),
                    kind,
                }
            })
            .collect())
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
        let hits = index.search("shared", 5, 0, None, None).unwrap();
        assert_eq!(hits.len(), 5); // not ~limit/2
    }

    #[test]
    fn offset_pages_walk_the_full_match_set_without_gaps_or_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let rows: Vec<IndexRow> = (0..7)
            .map(|i| {
                // Double-matching rows: the dedup must happen BEFORE paging,
                // or page boundaries would drop/duplicate sessions.
                let mut r = row("claude", &format!("s{i}"), i, "paged token");
                r.title = Some("paged".into());
                r
            })
            .collect();
        index.upsert(&rows).unwrap();

        let walk = |query: &str| {
            let mut seen = Vec::new();
            let mut offset = 0;
            loop {
                let page = index.search(query, 3, offset, None, None).unwrap();
                if page.is_empty() {
                    break;
                }
                offset += page.len();
                seen.extend(page.into_iter().map(|h| h.session_id));
            }
            seen
        };
        let newest_first: Vec<String> = (0..7).rev().map(|i| format!("s{i}")).collect();
        assert_eq!(walk("paged"), newest_first);
        assert_eq!(walk(""), newest_first);
    }

    #[test]
    fn lookup_answers_each_key_exactly_in_input_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        index
            .upsert(&[
                row("claude", "a", 1, "x"),
                row("kimi", "kimi-9", 2, "y"),
                row("codex", "c", 3, "z"),
            ])
            .unwrap();

        // A mixed batch across agents: a hit, the misattributed id (the
        // journal said claude; the index holds it under kimi), an unknown
        // id. Each answer names ITS OWN asked key; duplicates are the
        // caller's contract violation, not served.
        let answers = index
            .lookup(&[
                ("claude".into(), "a".into()),
                ("claude".into(), "kimi-9".into()),
                ("claude".into(), "nope".into()),
            ])
            .unwrap();
        let keyed = |agent: &str, id: &str, kind: LookupKind| KeyedAnswer {
            agent: agent.into(),
            session_id: id.into(),
            kind,
        };
        assert_eq!(
            answers,
            vec![
                keyed(
                    "claude",
                    "a",
                    LookupKind::Hit {
                        reference: "/store/a".into(),
                        title: Some("title a".into()),
                        mtime: 1,
                    },
                ),
                keyed(
                    "claude",
                    "kimi-9",
                    LookupKind::Foreign {
                        agents: vec!["kimi".into()],
                    },
                ),
                keyed("claude", "nope", LookupKind::Absent),
            ],
        );
        // The foreign arm must not fire for a key whose OWN agent holds the
        // row: same id, right agent — a plain hit, not a self-accusation.
        assert_eq!(
            index.lookup(&[("kimi".into(), "kimi-9".into())]).unwrap(),
            vec![keyed(
                "kimi",
                "kimi-9",
                LookupKind::Hit {
                    reference: "/store/kimi-9".into(),
                    title: Some("title kimi-9".into()),
                    mtime: 2,
                },
            )],
        );
        // Same id under TWO agents: the other one is named, both orders.
        index
            .upsert(&[row("opencode", "kimi-9", 4, "w")])
            .unwrap();
        assert_eq!(
            index.lookup(&[("claude".into(), "kimi-9".into())]).unwrap(),
            vec![keyed(
                "claude",
                "kimi-9",
                LookupKind::Foreign {
                    agents: vec!["kimi".into(), "opencode".into()],
                },
            )],
        );
        assert_eq!(
            index.lookup(&[("kimi".into(), "kimi-9".into())]).unwrap(),
            vec![keyed(
                "kimi",
                "kimi-9",
                LookupKind::Hit {
                    reference: "/store/kimi-9".into(),
                    title: Some("title kimi-9".into()),
                    mtime: 2,
                },
            )],
        );
    }

    #[test]
    fn lookup_of_no_keys_asks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        assert_eq!(index.lookup(&[]).unwrap(), Vec::<KeyedAnswer>::new());
    }

    #[test]
    fn lookup_leaves_sessions_the_ask_never_named_alone() {
        // The ask is keyed, not an enumeration: rows whose ids were not in
        // the batch contribute nothing to the answer, whatever their agent.
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        index
            .upsert(&[row("claude", "a", 1, "x"), row("codex", "b", 2, "y")])
            .unwrap();
        let answers = index.lookup(&[("claude".into(), "a".into())]).unwrap();
        assert_eq!(answers.len(), 1);
        assert_eq!(
            answers[0],
            KeyedAnswer {
                agent: "claude".into(),
                session_id: "a".into(),
                kind: LookupKind::Hit {
                    reference: "/store/a".into(),
                    title: Some("title a".into()),
                    mtime: 1,
                },
            },
        );
    }

    #[test]
    fn folder_scope_splits_the_store_both_ways_on_both_query_paths() {
        // Membership rides IN the query: Only picks the workspace's exact
        // folders, Except is its complement — on the empty-query path AND
        // the FTS/title path alike, and the totals agree with the pages.
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let mut in_ws = row("claude", "a", 3, "the auth bug lives here");
        in_ws.cwd = "/wt/kd-x-1".into();
        let mut other_ws = row("claude", "b", 2, "the auth bug lives here");
        other_ws.cwd = "/wt/kd-x-2".into();
        let mut global = row("codex", "c", 1, "unrelated work");
        global.cwd = "/elsewhere".into();
        index.upsert(&[in_ws, other_ws, global]).unwrap();

        let scope = FolderScope::Only(vec!["/wt/kd-x-1".into(), "/gone".into()]);
        let top = index.search("", 10, 0, None, Some(&scope)).unwrap();
        assert_eq!(
            top.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            ["a"],
        );
        // The content path honors the same scope — a content hit in a
        // foreign folder is as foreign as a title one.
        let top_hit = index.search("auth", 10, 0, None, Some(&scope)).unwrap();
        assert_eq!(
            top_hit.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            ["a"],
        );
        assert_eq!(index.search_total("", None, Some(&scope)).unwrap(), 1);
        assert_eq!(index.search_total("auth", None, Some(&scope)).unwrap(), 1);

        let bottom = FolderScope::Except(vec!["/wt/kd-x-1".into(), "/gone".into()]);
        let rest = index.search("", 10, 0, None, Some(&bottom)).unwrap();
        assert_eq!(
            rest.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            ["b", "c"],
        );
        let rest_hit = index.search("auth", 10, 0, None, Some(&bottom)).unwrap();
        assert_eq!(
            rest_hit.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            ["b"],
        );
        assert_eq!(index.search_total("auth", None, Some(&bottom)).unwrap(), 1);
    }

    #[test]
    fn folder_scope_membership_is_exact_and_edges_are_honest() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let mut r = row("claude", "s1", 1, "x");
        r.cwd = "/wt/kd-KeepDeck-12".into();
        index.upsert(&[r]).unwrap();

        // Exact paths, not stems: the sibling does not match.
        let stem = FolderScope::Only(vec!["/wt/kd-KeepDeck-1".into()]);
        assert_eq!(index.search("", 10, 0, None, Some(&stem)).unwrap().len(), 0);

        // Except with NO folders excludes nothing — the global block's
        // degenerate case. Only with NO folders matches nothing (a real
        // workspace always carries its own folder; kept honest anyway).
        let no_except = FolderScope::Except(vec![]);
        assert_eq!(index.search_total("", None, Some(&no_except)).unwrap(), 1);
        let no_only = FolderScope::Only(vec![]);
        assert_eq!(index.search_total("", None, Some(&no_only)).unwrap(), 0);
    }

    #[test]
    fn folder_scope_composes_with_the_agent_filter() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let mut mine = row("claude", "a", 2, "token");
        mine.cwd = "/mine".into();
        let mut foreign_agent = row("kimi", "b", 1, "token");
        foreign_agent.cwd = "/mine".into();
        index.upsert(&[mine, foreign_agent]).unwrap();

        let scope = FolderScope::Only(vec!["/mine".into()]);
        let hits = index
            .search("token", 10, 0, Some("claude"), Some(&scope))
            .unwrap();
        assert_eq!(
            hits.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            ["a"],
        );
        assert_eq!(
            index.search_total("token", Some("claude"), Some(&scope)).unwrap(),
            1,
        );
    }

    #[test]
    fn lookup_answers_carry_their_own_keys_in_any_order() {
        // INVARIANT: an answer belongs to its question by KEY, never by
        // position. A batch asked in one order and (conceptually) served
        // in another must never cross wires — and the ANSWER type itself
        // must make crossing impossible by carrying the key it answers.
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let mut known = row("claude", "k1", 3, "x");
        known.cwd = "/a".into();
        let mut other = row("codex", "k2", 2, "y");
        other.cwd = "/b".into();
        index.upsert(&[known, other]).unwrap();

        let answers = index
            .lookup(&[
                ("claude".into(), "k1".into()),
                ("codex".into(), "k2".into()),
            ])
            .unwrap();
        // Every variant names the key it answers — hit, foreign, absent
        // alike; absence by key, not by position.
        assert_eq!(answers[0].agent, "claude");
        assert_eq!(answers[0].session_id, "k1");
        assert_eq!(answers[1].agent, "codex");
        assert_eq!(answers[1].session_id, "k2");
        // The foreign branch answers by the ASKED agent, not the found
        // one — the wrong-attribution signature.
        let foreign = index
            .lookup(&[("claude".into(), "k2".into())])
            .unwrap();
        assert_eq!(foreign[0].agent, "claude");
        assert_eq!(foreign[0].session_id, "k2");
    }

    #[test]
    fn lookup_rejects_duplicate_keys() {
        // The contract forbids asking one key twice: with keyed answers,
        // a duplicate would be two truths for one question, and the
        // consumer's by-key fold would silently overwrite. Dedup by the
        // caller is no substitute — the error names the caller.
        let dir = tempfile::tempdir().unwrap();
        let index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let result = index.lookup(&[
            ("claude".into(), "a".into()),
            ("claude".into(), "a".into()),
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn agent_filter_narrows_search_and_total() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        index
            .upsert(&[
                row("claude", "a", 3, "shared themes"),
                row("codex", "b", 2, "shared themes"),
                row("claude", "c", 1, "unrelated"),
            ])
            .unwrap();

        let all = index.search("", 10, 0, Some("claude"), None).unwrap();
        assert_eq!(
            all.iter().map(|h| h.session_id.as_str()).collect::<Vec<_>>(),
            ["a", "c"],
        );
        let hits = index.search("shared", 10, 0, Some("claude"), None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "a");
        // Title-only matches obey the filter too (the LIKE arm).
        let title = index.search("title b", 10, 0, Some("claude"), None).unwrap();
        assert!(title.is_empty());

        assert_eq!(index.search_total("", None, None).unwrap(), 3);
        assert_eq!(index.search_total("", Some("claude"), None).unwrap(), 2);
        assert_eq!(index.search_total("shared", None, None).unwrap(), 2);
        assert_eq!(index.search_total("shared", Some("codex"), None).unwrap(), 1);
    }

    #[test]
    fn total_counts_double_matching_sessions_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
        let mut r = row("claude", "s1", 1, "shared token");
        r.title = Some("shared".into());
        index.upsert(&[r]).unwrap();
        assert_eq!(index.search_total("shared", None, None).unwrap(), 1);
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

        let all = index.search("", 10, 0, None, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].session_id, "a"); // newest first

        let hits = index.search("token refr", 10, 0, None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.as_deref().unwrap().contains("[token]"));

        // Title match without a content match still surfaces.
        let title = index.search("title b", 10, 0, None, None).unwrap();
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
        assert_eq!(dropped, vec![("claude".into(), "b".into())]);
        assert_eq!(index.search("", 10, 0, None, None).unwrap().len(), 1);
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
        assert_eq!(index.search("", 10, 0, None, None).unwrap().len(), 0); // rebuilt empty
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

    // ── Characterization table: TODAY's membership and identity, pinned
    // BEFORE any core extraction. Honest name — these tests state what
    // the current SQL does, not what a spec would want. Each row names
    // its EXACT keys and total from THREE sources: the page, the
    // counter, and a count derived from the FIXTURE'S OWN CONSTRUCTION
    // (which rows carry the term where, in which folder, under which
    // agent) — a broken core makes the first two lie together, so the
    // third must not come from the database at all. All mtimes in a
    // fixture are DISTINCT: with equal dates the expected order is
    // undefined and the row would pass or fail by luck.
    mod characterization {
        use super::*;

        fn ids(hits: &[SearchHit]) -> Vec<&str> {
            hits.iter().map(|h| h.session_id.as_str()).collect()
        }

        #[test]
        fn t1_empty_query_no_agent_no_folders() {
            let dir = tempfile::tempdir().unwrap();
            let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
            let rows = vec![
                row("claude", "a", 40, "quiet"),
                row("kimi", "b", 30, "quiet"),
                row("codex", "e", 20, "quiet"),
                row("claude", "d", 10, "quiet"),
            ];
            index.upsert(&rows).unwrap();
            // By construction: an empty query matches EVERY row — the
            // direct count is the fixture's own length.
            assert_eq!(rows.len(), 4);
            let expected = ["a", "b", "e", "d"]; // newest first
            assert_eq!(ids(&index.search("", 10, 0, None, None).unwrap()), expected);
            assert_eq!(
                index.search_total("", None, None).unwrap(),
                expected.len() as i64
            );
        }

        #[test]
        fn t2_search_query_no_agent_no_folders() {
            let dir = tempfile::tempdir().unwrap();
            let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
            let mut title_only = row("claude", "pc", 30, "silent work");
            title_only.title = Some("token report".into());
            let rows = vec![
                row("claude", "pa", 50, "token early"),
                row("kimi", "pb", 40, "token two"),
                title_only,
                row("codex", "pd", 20, "unrelated"), // neither arm matches
            ];
            index.upsert(&rows).unwrap();
            // By construction: pa and pb carry "token" in CONTENT, pc in
            // TITLE, pd in neither — three keys.
            let expected = ["pa", "pb", "pc"];
            assert_eq!(ids(&index.search("token", 10, 0, None, None).unwrap()), expected);
            assert_eq!(
                index.search_total("token", None, None).unwrap(),
                expected.len() as i64
            );
        }

        #[test]
        fn t3_empty_query_with_agent_and_folders() {
            let dir = tempfile::tempdir().unwrap();
            let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
            let mut a = row("claude", "a", 40, "x");
            a.cwd = "/mine".into();
            let mut b = row("kimi", "b", 30, "x");
            b.cwd = "/mine".into();
            let mut c = row("claude", "c", 20, "x");
            c.cwd = "/elsewhere".into();
            let mut d = row("claude", "d", 10, "x");
            d.cwd = "/mine".into();
            index.upsert(&[a, b, c, d]).unwrap();
            let scope = FolderScope::Only(vec!["/mine".into()]);
            // By construction: claude AND /mine is a and d — b fails the
            // agent, c the folder.
            let expected = ["a", "d"];
            assert_eq!(
                ids(&index.search("", 10, 0, Some("claude"), Some(&scope)).unwrap()),
                expected
            );
            assert_eq!(
                index
                    .search_total("", Some("claude"), Some(&scope))
                    .unwrap(),
                expected.len() as i64
            );
        }

        #[test]
        fn t4_title_match_under_folder_scope_snippet_null() {
            let dir = tempfile::tempdir().unwrap();
            let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
            let mut t1 = row("claude", "t1", 40, "morning notes");
            t1.cwd = "/mine".into();
            t1.title = Some("zephyr report".into());
            let mut t2 = row("claude", "t2", 30, "evening notes");
            t2.cwd = "/elsewhere".into();
            t2.title = Some("zephyr elsewhere".into());
            index.upsert(&[t1, t2]).unwrap();
            let scope = FolderScope::Only(vec!["/mine".into()]);
            // Positive partner for "zero content matches": the content
            // arm is ALIVE in this fixture — a word that IS in t1's
            // content finds it WITH a snippet. Without this, "zephyr
            // hit nothing by content" could mean a dead arm. (Unscoped
            // on purpose: the partner proves the FIXTURE's content is
            // indexed and findable; the scoped behavior is asserted by
            // the main line below.)
            let alive = index.search("morning", 10, 0, None, None).unwrap();
            assert_eq!(ids(&alive), ["t1"]);
            assert!(alive[0].snippet.is_some());
            // By construction: "zephyr" is in titles only; /mine holds
            // t1 alone — one key, no snippet (K2: no content match, no
            // snippet; K4 first half).
            let page = index.search("zephyr", 10, 0, None, Some(&scope)).unwrap();
            assert_eq!(ids(&page), ["t1"]);
            assert_eq!(page[0].snippet, None);
            assert_eq!(
                index.search_total("zephyr", None, Some(&scope)).unwrap(),
                1
            );
        }

        #[test]
        fn t5_search_with_agent_and_folders_double_match() {
            let dir = tempfile::tempdir().unwrap();
            let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
            let mut m1 = row("claude", "m1", 50, "token alpha");
            m1.cwd = "/mine".into();
            let mut m2 = row("claude", "m2", 40, "quiet work");
            m2.cwd = "/mine".into();
            m2.title = Some("token beta".into());
            let mut m3 = row("claude", "m3", 30, "token gamma");
            m3.cwd = "/mine".into();
            m3.title = Some("token gamma too".into());
            let mut m4 = row("kimi", "m4", 20, "token delta");
            m4.cwd = "/mine".into();
            let mut m5 = row("claude", "m5", 60, "token eps");
            m5.cwd = "/elsewhere".into();
            index.upsert(&[m1, m2, m3, m4, m5]).unwrap();
            let scope = FolderScope::Only(vec!["/mine".into()]);
            // By construction: claude AND /mine AND (content OR title
            // "token") is m1 (content), m2 (title), m3 (both) — m4
            // fails the agent, m5 the folder. The double-matching m3
            // is ONE key.
            let expected = ["m1", "m2", "m3"];
            let page = index
                .search("token", 10, 0, Some("claude"), Some(&scope))
                .unwrap();
            assert_eq!(ids(&page), expected);
            let total = index
                .search_total("token", Some("claude"), Some(&scope))
                .unwrap();
            assert_eq!(total, expected.len() as i64);
            // The counter and the page describe the SAME set: same
            // count, and K2 holds per key — content-found m1 carries a
            // snippet, title-found m2 does not, double-found m3 does.
            assert_eq!(page.len() as i64, total);
            assert!(page[0].snippet.is_some());
            assert_eq!(page[1].snippet, None);
            assert!(page[2].snippet.is_some());
        }

        #[test]
        fn t7_snippet_by_match_kind_double_match_is_one_key() {
            let dir = tempfile::tempdir().unwrap();
            let mut index = SessionIndex::open(&dir.path().join("i.sqlite")).unwrap();
            let mut s_content = row("claude", "s-content", 50, "token early");
            s_content.title = Some("plain day".into());
            let mut s_double = row("claude", "s-double", 40, "token gamma");
            s_double.title = Some("token gamma too".into());
            let mut s_title = row("claude", "s-title", 30, "quiet");
            s_title.title = Some("token beta".into());
            let rows = vec![
                s_content,
                s_double,
                s_title,
                row("codex", "s-noise", 20, "unrelated"),
            ];
            index.upsert(&rows).unwrap();
            // By construction: three keys match "token" — content-only,
            // double, title-only — the union of two arms holds FOUR
            // rows, the answer holds THREE (K4: a double match is one
            // key).
            let expected = ["s-content", "s-double", "s-title"];
            let page = index.search("token", 10, 0, None, None).unwrap();
            assert_eq!(ids(&page), expected);
            // K2: a snippet exists EXACTLY when the session matched by
            // CONTENT — s-title found by title alone has none.
            assert!(page[0].snippet.is_some());
            assert!(page[1].snippet.is_some());
            assert_eq!(page[2].snippet, None);
            assert_eq!(
                index.search_total("token", None, None).unwrap(),
                expected.len() as i64
            );
        }
    }
}
