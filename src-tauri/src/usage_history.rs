//! `usage-history.jsonl` — durable, append-only pane-usage deltas.
//!
//! The webview owns schema, deduplication, retention and aggregation; the
//! shared [`crate::jsonl_log`] owns the file mechanics.

use crate::jsonl_log;

const USAGE_HISTORY_FILE: &str = "usage-history.jsonl";

#[tauri::command(async)]
pub fn usage_history_load() -> Result<Vec<String>, String> {
    jsonl_log::load(&jsonl_log::log_path(USAGE_HISTORY_FILE)?)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn usage_history_append(lines: Vec<String>) -> Result<(), String> {
    jsonl_log::append(&jsonl_log::log_path(USAGE_HISTORY_FILE)?, &lines)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn usage_history_compact(lines: Vec<String>) -> Result<(), String> {
    let joined = jsonl_log::join(&lines).map_err(|error| error.to_string())?;
    crate::state::write_atomic(&jsonl_log::log_path(USAGE_HISTORY_FILE)?, joined.as_bytes())
        .map_err(|error| error.to_string())
}
