//! The `sqliteReadonly` capability's backend — the database sibling of
//! `plugins_fs_write`: a plugin whose store is SQLite (opencode) runs a
//! single parameterized SELECT against it, containment-checked against the
//! manifest-declared prefixes and opened read-only (the store cannot be
//! mutated or locked up). The SQL text lives in the plugin — the schema
//! knowledge is its; this command only enforces the boundary.

use crate::containment::{expand_home, resolve_within};

#[tauri::command(async)]
pub fn plugins_sqlite_query(
    db_path: String,
    sql: String,
    params: Vec<String>,
    roots: Vec<String>,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let expanded: Vec<String> = roots
        .iter()
        .map(|root| expand_home(root))
        .collect::<Result<_, _>>()?;
    let db = resolve_within(&expand_home(&db_path)?, &expanded, false)?;
    keepdeck_index::query_readonly(&db, &sql, &params)
}
