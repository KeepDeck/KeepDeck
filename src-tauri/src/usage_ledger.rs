//! Adapter over `keepdeck-usage`: the usage ledger lives at
//! `<keepdeck_home>/usage.sqlite`.
//!
//! The first command opens it and, once, imports the old
//! `usage-history.jsonl` — under the lock, so a report that arrives during
//! the import waits for it instead of racing it. The commands run on the
//! worker pool, so a long first import holds a worker, never the UI.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_usage::{import_jsonl, CaptureContext, Ledger, LedgerRow, UsageReport, UsageStore};
use serde::Deserialize;
use tauri::State;

const STORE_FILE: &str = "usage.sqlite";
/// The ledger file this store replaces; imported once, then kept aside.
const OLD_LEDGER_FILE: &str = "usage-history.jsonl";

#[derive(Default)]
pub struct UsageLedgerState(Mutex<Option<UsageStore>>);

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

fn with_store<T>(
    state: &State<'_, UsageLedgerState>,
    f: impl FnOnce(&mut UsageStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "usage ledger lock poisoned")?;
    if guard.is_none() {
        let home = crate::paths::keepdeck_home().ok_or("no home directory for app state")?;
        let mut store = UsageStore::open(&home.join(STORE_FILE))?;
        let imported = import_jsonl(&mut store, &home.join(OLD_LEDGER_FILE), now_ms())?;
        if let Some(kept) = &imported.kept_as {
            log::info!(
                "usage ledger: imported {} lines ({} withheld, {} unreadable); the old file is kept as {}",
                imported.lines,
                imported.withheld,
                imported.skipped,
                kept.display()
            );
        }
        *guard = Some(store);
    }
    f(guard.as_mut().expect("just opened"))
}

/// The ledger as the webview holds it: compacted history, recent events raw.
#[tauri::command(async)]
pub fn usage_ledger(state: State<'_, UsageLedgerState>) -> Result<Ledger, String> {
    with_store(&state, |store| store.ledger(now_ms()))
}

/// One pane report to book.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordEntry {
    report: UsageReport,
    context: CaptureContext,
    captured_at: f64,
}

/// Book one pane report: the row it adds to the ledger, or null when there
/// was nothing to book.
#[tauri::command(async)]
pub fn usage_record(
    state: State<'_, UsageLedgerState>,
    entry: RecordEntry,
) -> Result<Option<LedgerRow>, String> {
    with_store(&state, |store| {
        store.record(&entry.report, &entry.context, entry.captured_at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_entry_reads_the_webviews_camel_case_wire() {
        let entry: RecordEntry = serde_json::from_str(
            r#"{"report":{"agent":"claude","model":"Opus","totalTokens":{"input":5,"cacheRead":2},
                "costUsd":0.1,"reportedAt":10,"sequence":3},
               "context":{"workspaceId":"ws-1","workspaceName":"Deck","workspaceCwd":"/r",
                "paneId":"p","paneName":"n","sessionId":"s","origin":"inherited",
                "worktree":{"path":"/w","branch":"b","repo":"/r"}},
               "capturedAt":11}"#,
        )
        .expect("the wire the webview sends");
        assert_eq!(entry.report.total_tokens.unwrap().cache_read, Some(2.0));
        assert_eq!(
            entry.context.origin,
            keepdeck_usage::model::SessionOrigin::Inherited
        );
        assert_eq!(entry.captured_at, 11.0);
    }
}
