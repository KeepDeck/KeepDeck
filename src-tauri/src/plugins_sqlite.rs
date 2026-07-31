//! The `sqliteReadonly` capability's backend — the database sibling of
//! `plugins_fs_write`: a plugin whose store is SQLite (opencode) runs a
//! single parameterized SELECT against it, containment-checked against the
//! manifest-declared prefixes and opened read-only (the store cannot be
//! mutated or locked up). The SQL text lives in the plugin — the schema
//! knowledge is its; this command only enforces the boundary.

use std::path::PathBuf;

use crate::containment::{expand_home, is_unbounded_root, resolve_within};

#[tauri::command(async)]
pub fn plugins_sqlite_query(
    db_path: String,
    sql: String,
    params: Vec<String>,
    roots: Vec<String>,
) -> Result<Vec<Vec<Option<String>>>, String> {
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
    keepdeck_index::query_readonly(&db, &sql, &params)
}
