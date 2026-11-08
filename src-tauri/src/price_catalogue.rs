//! The price catalogue's refresh: models.dev's `api.json`, asked once a day
//! with the validator of its last answer, its changes journaled into the
//! usage store.
//!
//! Only the asking lives here — the transport. What the answer means (which
//! providers count, what a price is, whether it moved) is `keepdeck-usage`'s
//! catalogue, and what a price does to the ledger is its pricing.
//!
//! The check is cheap when nothing changed (a 304 with no body), and a
//! failure costs nothing but a log line: the journal keeps every price it
//! has, so a day without the network prices exactly like the day before.

use std::io::Read;
use std::thread;
use std::time::Duration;

use keepdeck_usage::catalogue;
use keepdeck_usage::store::CatalogueState;
use tauri::{AppHandle, Manager};

use crate::usage_ledger::{now_ms, with_store, UsageLedgerState};

const CATALOGUE_URL: &str = "https://models.dev/api.json";

/// How stale the journal may get before the catalogue is asked again.
const REFRESH_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// How often the refresh looks at whether it is due. Hourly, so a machine
/// that slept through the due moment catches up within the hour it wakes.
const POLL: Duration = Duration::from_secs(60 * 60);

/// The first look waits for the app to finish starting.
const FIRST_LOOK: Duration = Duration::from_secs(60);

const TIMEOUT: Duration = Duration::from_secs(30);

/// `api.json` is ~6 MB uncompressed; the cap leaves room to grow and still
/// stops a runaway answer.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Start the refresh for the app's lifetime.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("price-catalogue".into())
        .spawn(move || {
            thread::sleep(FIRST_LOOK);
            loop {
                if let Err(e) = refresh_if_due(&app) {
                    log::warn!("price catalogue: {e}");
                }
                thread::sleep(POLL);
            }
        });
    if let Err(e) = spawned {
        log::warn!("price catalogue: refresh not started: {e}");
    }
}

/// Whether the journal is due a look at the catalogue at `now`.
fn due(state: &CatalogueState, now: f64) -> bool {
    state.checked_at.is_none_or(|at| now - at >= REFRESH_MS)
}

fn refresh_if_due(app: &AppHandle) -> Result<(), String> {
    let ledger = app.state::<UsageLedgerState>();
    let state = with_store(&ledger, |store| store.catalogue_state())?;
    if !due(&state, now_ms()) {
        return Ok(());
    }
    let answer = fetch(state.etag.as_deref())?;
    let at = now_ms();
    let added = match answer {
        Answer::NotModified => with_store(&ledger, |store| store.apply_catalogue(None, None, at))?,
        Answer::Fresh { body, etag } => {
            // Parsed outside the lock: six megabytes of JSON is the slow part.
            let entries = catalogue::parse_api(&body)?;
            with_store(&ledger, |store| store.apply_catalogue(Some(&entries), etag.as_deref(), at))?
        }
    };
    if added > 0 {
        log::info!("price catalogue: {added} price change(s) journaled");
    }
    Ok(())
}

enum Answer {
    NotModified,
    Fresh { body: String, etag: Option<String> },
}

fn fetch(etag: Option<&str>) -> Result<Answer, String> {
    let mut request = ureq::get(CATALOGUE_URL).timeout(TIMEOUT);
    if let Some(etag) = etag {
        request = request.set("If-None-Match", etag);
    }
    let response = request.call().map_err(|e| format!("catalogue request failed: {e}"))?;
    if response.status() == 304 {
        return Ok(Answer::NotModified);
    }
    let etag = response.header("ETag").map(str::to_owned);
    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_BYTES)
        .read_to_string(&mut body)
        .map_err(|e| format!("catalogue body unreadable: {e}"))?;
    Ok(Answer::Fresh { body, etag })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: f64 = 86_400_000.0;

    #[test]
    fn a_journal_never_checked_is_due() {
        assert!(due(&CatalogueState::default(), 0.0));
    }

    #[test]
    fn a_journal_is_due_a_day_after_its_last_check_and_not_before() {
        let state = CatalogueState { etag: None, checked_at: Some(10.0 * DAY) };
        assert!(!due(&state, 11.0 * DAY - 1.0));
        assert!(due(&state, 11.0 * DAY));
    }
}
