//! The `sqliteReadonly` capability's backend — the database sibling of
//! `plugins_fs_write`: a plugin whose store is SQLite (opencode) runs a
//! single parameterized SELECT against it, containment-checked against the
//! manifest-declared prefixes and opened read-only (the store cannot be
//! mutated or locked up). The SQL text lives in the plugin — the schema
//! knowledge is its; this command only enforces the boundary.

use std::path::PathBuf;

use serde::Serialize;

use crate::containment::{expand_home, is_unbounded_root, resolve_within};

/// One query's answer, as the plugin sees it.
///
/// The rows no longer travel alone: a read that the host cut short has to
/// say so, or a caller shows a truncated answer as a complete one. The
/// vocabulary of stop reasons is the file reader's, deliberately — a plugin
/// that already knows what "budget" means from reading files should not
/// learn a second word for it here.
///
/// The shape lives HERE rather than in the crate because it is a wire shape,
/// and the crates in this workspace carry no serialization: [`SqlRead`] is
/// its plain twin, and the mapping below is the whole price of that split.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAnswer {
    pub rows: Vec<Vec<Option<String>>>,
    /// `"exhausted"` — the query had nothing more to give.
    /// `"budget"` — the host stopped it, and the answer is incomplete.
    pub stopped: &'static str,
    /// Effective bytes this answer passed through.
    pub payload_bytes: usize,
}

#[tauri::command(async)]
pub fn plugins_sqlite_query(
    db_path: String,
    sql: String,
    params: Vec<String>,
    roots: Vec<String>,
) -> Result<SqlAnswer, String> {
    // Same rule as the write side: a declared root whose canonical form is
    // "/" or the whole home bounds nothing and authorizes nothing — the
    // parse guard refuses the literal spellings, the proof refuses the rest.
    let expanded: Vec<String> = roots
        .iter()
        .map(|root| expand_home(root))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|root| {
            let path = PathBuf::from(root);
            let real = std::fs::canonicalize(&path).unwrap_or(path);
            !is_unbounded_root(&real)
        })
        .collect();
    let db = resolve_within(&expand_home(&db_path)?, &expanded, false)?;
    let read = keepdeck_index::query_readonly(&db, &sql, &params)?;
    Ok(SqlAnswer {
        rows: read.rows,
        stopped: if read.short { "budget" } else { "exhausted" },
        payload_bytes: read.payload_bytes,
    })
}
