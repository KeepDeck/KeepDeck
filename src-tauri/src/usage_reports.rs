//! `usage-reports.jsonl` — the provider window-report journal: the history
//! of `usedPct` readings the exhaustion forecast computes its pace from.
//! Same durability contract as the usage history; schema lives in the
//! webview's domain codec.

use crate::jsonl_log;

const USAGE_REPORTS_FILE: &str = "usage-reports.jsonl";

#[tauri::command(async)]
pub fn usage_reports_load() -> Result<Vec<String>, String> {
    jsonl_log::load(&jsonl_log::log_path(USAGE_REPORTS_FILE)?)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn usage_reports_append(lines: Vec<String>) -> Result<(), String> {
    jsonl_log::append(&jsonl_log::log_path(USAGE_REPORTS_FILE)?, &lines)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn usage_reports_compact(lines: Vec<String>) -> Result<(), String> {
    let joined = jsonl_log::join(&lines).map_err(|error| error.to_string())?;
    crate::state::write_atomic(&jsonl_log::log_path(USAGE_REPORTS_FILE)?, joined.as_bytes())
        .map_err(|error| error.to_string())
}
