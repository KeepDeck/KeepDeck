//! Adapter over `keepdeck-usage`: the usage ledger lives at
//! `<keepdeck_home>/usage.sqlite`.
//!
//! The first command opens it — migrating an older schema under the lock, so
//! a booking that arrives meanwhile waits instead of racing it — and merges
//! the price history this build ships into its journal. The commands run on
//! the worker pool, so a long migration holds a worker, never the UI.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use keepdeck_usage::{catalogue, CallBatch, Ledger, LedgerRow, UsageStore};
use serde::Deserialize;
use tauri::State;

const STORE_FILE: &str = "usage.sqlite";

#[derive(Default)]
pub struct UsageLedgerState(Mutex<Option<UsageStore>>);

pub(crate) fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Run `f` on the store, opening it first if this run has not yet.
pub(crate) fn with_store<T>(
    state: &UsageLedgerState,
    f: impl FnOnce(&mut UsageStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "usage ledger lock poisoned")?;
    if guard.is_none() {
        let home = crate::paths::keepdeck_home().ok_or("no home directory for app state")?;
        let now = now_ms();
        let mut store = UsageStore::open(&home.join(STORE_FILE), now)?;
        let changed = store.adopt_seed(&catalogue::seed()?, now)?;
        if changed > 0 {
            log::info!("usage ledger: the shipped price history changed {changed} row(s) of the journal");
        }
        *guard = Some(store);
    }
    f(guard.as_mut().expect("just opened"))
}

/// The ledger as the webview holds it: compacted history, recent events raw,
/// every row priced.
#[tauri::command(async)]
pub fn usage_ledger(state: State<'_, UsageLedgerState>) -> Result<Ledger, String> {
    with_store(&state, |store| store.ledger(now_ms()))
}

/// Calls one pane reported, to book.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookEntry {
    batch: CallBatch,
    captured_at: f64,
}

/// Book a pane's calls: the rows they add to the ledger, none when every
/// call was booked already or is not the deck's to book.
#[tauri::command(async)]
pub fn usage_book_calls(
    state: State<'_, UsageLedgerState>,
    entry: BookEntry,
) -> Result<Vec<LedgerRow>, String> {
    with_store(&state, |store| store.book(&entry.batch, entry.captured_at))
}

/// From when a followed session file must be read again (unix ms): see
/// `UsageStore::since`.
#[tauri::command(async)]
pub fn usage_since(
    state: State<'_, UsageLedgerState>,
    agent: String,
    session_id: String,
    first_seen: f64,
) -> Result<f64, String> {
    with_store(&state, |store| store.since(&agent, &session_id, first_seen, now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_book_entry_reads_the_webviews_camel_case_wire() {
        let entry: BookEntry = serde_json::from_str(
            r#"{"batch":{"agent":"claude","sessionId":"s","firstSeen":5,
                "place":{"workspaceId":"ws-1","workspaceName":"Deck","workspaceCwd":"/r",
                         "paneId":"p","paneName":"n","worktree":{"path":"/w","branch":"b","repo":"/r"}},
                "calls":[{"id":"msg_1","at":9,"provider":"anthropic","model":"claude-opus-5-5","mode":"fast",
                          "tokens":{"input":5,"cacheRead":2,"cacheWrite":1,"cacheWrite1h":3,"output":7}}]},
               "capturedAt":11}"#,
        )
        .expect("the wire the webview sends");
        let call = &entry.batch.calls[0];
        assert_eq!(call.mode.as_deref(), Some("fast"));
        assert_eq!(call.tokens.cache_write_1h, 3.0);
        assert_eq!(call.tokens.reasoning, 0.0, "a class the agent does not report is zero");
        assert_eq!(entry.batch.first_seen, 5.0);
        assert_eq!(entry.batch.place.worktree.as_ref().map(|w| w.repo.as_str()), Some("/r"));
        assert_eq!(entry.captured_at, 11.0);
    }
}
