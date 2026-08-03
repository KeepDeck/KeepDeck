//! The CLI bridge — the one-way channel a pane's own agent process uses to
//! report facts back to KeepDeck: its session id (identity) and its usage
//! reports (rate-limit windows, tokens, cost).
//!
//! This module is the composition: watch the inbox [`inbox`] publishes, parse
//! what lands with [`wire`], emit it, consume the file. The two halves it
//! composes change for different reasons — the wire schema when the deck
//! needs a new field, the inbox when locking or sweeping semantics do — and
//! only the wire half is shared outside the bridge (the session tailer emits
//! the same shapes for what it recovers from transcripts).
//!
//! Transport: a per-RUN inbox directory. Each launch mints
//! `<keepdeck_home>/bridge/run-<uuid>/`, holds an OS file lock on `lock`
//! inside it for the process's lifetime, and watches for `*.json` envelope
//! drops. Reporters (hook/plugin shipped with KeepDeck, armed per spawn via
//! the single `KEEPDECK_BRIDGE` env var) write one uniquely-named file per
//! message — tmp + rename, so the watcher never sees a torn file — and the
//! watcher parses, emits and consumes it.
//!
//! The bridge is an ephemeral signal bus, not a durable queue: every run
//! starts with a fresh empty inbox and whatever a dead run left is deleted
//! unread. Envelopes are data, never code: size-capped, schema-validated,
//! logged only after control characters are stripped, and carrying a
//! per-spawn token the webview verifies against the pane's own spawn plan
//! before applying anything.

mod inbox;
mod wire;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use wire::{interpret, printable, Inbound, SESSION_BOUND_EVENT};
// Only what the rest of the crate actually consumes: the session tailer emits
// `Report` on these two event names. `SessionBound` and its event name never
// leave the bridge — a binding is built from an envelope and emitted in the
// same breath, and nothing outside re-emits one.
pub use wire::{Report, AGENT_STATUS_EVENT, USAGE_REPORT_EVENT};

/// An envelope larger than this is dropped unread — reporters send small
/// JSON (a statusline payload runs a few KB; the cap leaves generous
/// headroom for bloated workspace lists), anything bigger is not ours.
const MAX_ENVELOPE_BYTES: u64 = 256 * 1024;

/// This run's live bridge — kept in Tauri managed state so the lock fd and
/// the watcher survive for the app's lifetime.
pub struct Bridge {
    /// The inbox spawns advertise via `KEEPDECK_BRIDGE`.
    pub run_dir: PathBuf,
    _lock: File,
    _watcher: notify::RecommendedWatcher,
}

/// Boot the bridge: sweep orphaned inboxes, publish this run's own, watch it.
pub fn start(app: &AppHandle) -> Result<Bridge, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for the bridge")?;
    // Pre-bridge installs dropped postbacks into one shared spool; reap it
    // once so it doesn't sit around forever.
    let _ = fs::remove_dir_all(home.join("session-spool"));

    let root = home.join("bridge");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    inbox::restrict(&root);

    let (run_dir, lock, swept) = inbox::boot(&root)?;
    log::info!(
        "bridge: inbox {} (swept {swept} orphaned run dir(s))",
        run_dir.display()
    );

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else { return };
        // Reporters write via tmp + rename, so a Create/Modify means a whole
        // file. Anything unparsable is consumed and dropped (never loops).
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        for path in &event.paths {
            deliver(&emitter, path);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&run_dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    Ok(Bridge {
        run_dir,
        _lock: lock,
        _watcher: watcher,
    })
}

/// Why an inbox file yielded no event.
enum Rejected {
    /// IO race (writer mid-rename, file already consumed) — leave the file,
    /// it re-fires on its own next event.
    Transient,
    /// Bad content — consumed and dropped, with the reason for the log.
    Dropped(String),
}

/// Read → interpret → emit → consume one inbox file.
fn deliver(app: &AppHandle, path: &Path) {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return; // tmp staging files, the lock, and strays
    }
    match consume_file(path) {
        Ok(Inbound::SessionBound(bound)) => {
            log::info!(
                "bridge: bound pane={} session={}",
                printable(&bound.pane_id),
                printable(&bound.session_id),
            );
            if let Err(e) = app.emit(SESSION_BOUND_EVENT, &bound) {
                log::warn!("bridge: emitting {SESSION_BOUND_EVENT} failed: {e}");
            }
        }
        // Opaque reports arrive continuously (per statusline update / turn
        // transition) — debug, not info, or they'd dominate keepdeck.log.
        Ok(Inbound::Opaque { event, report }) => {
            log::debug!("bridge: {event} pane={}", printable(&report.pane_id));
            if let Err(e) = app.emit(event, &report) {
                log::warn!("bridge: emitting {event} failed: {e}");
            }
        }
        Err(Rejected::Transient) => return,
        // A reporter wrote garbage — consumed and dropped by design, but a
        // trace is the difference between "hook broken" and "hook never ran".
        Err(Rejected::Dropped(reason)) => log::warn!("bridge: dropped envelope: {reason}"),
    }
    if let Err(e) = fs::remove_file(path) {
        // A stuck envelope re-fires on every inbox event until it's gone.
        log::warn!("bridge: consuming {} failed: {e}", path.display());
    }
}

/// One inbox file → one event, enforcing the size cap before reading.
/// Only a VANISHED file is transient (already consumed / writer mid-rename —
/// it re-fires or is gone for good reason); any other IO failure is dropped
/// like garbage, because a completed file gets no further fs events and
/// would otherwise sit in the inbox unread forever.
fn consume_file(path: &Path) -> Result<Inbound, Rejected> {
    let vanished_or = |e: std::io::Error, what: &str| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Rejected::Transient
        } else {
            Rejected::Dropped(format!("{what}: {e}"))
        }
    };
    let meta = fs::metadata(path).map_err(|e| vanished_or(e, "unstattable envelope"))?;
    if meta.len() > MAX_ENVELOPE_BYTES {
        return Err(Rejected::Dropped(format!(
            "oversized envelope ({} bytes)",
            meta.len()
        )));
    }
    let content = fs::read_to_string(path).map_err(|e| vanished_or(e, "unreadable envelope"))?;
    interpret(&content).map_err(Rejected::Dropped)
}

#[cfg(test)]
mod tests {
    use super::wire::tests::envelope;
    use super::wire::SessionBound;
    use super::*;

    #[test]
    fn consuming_enforces_the_size_cap_and_reads_valid_envelopes() {
        let root = tempfile::tempdir().unwrap();
        let big = root.path().join("big.json");
        fs::write(&big, "x".repeat((MAX_ENVELOPE_BYTES + 1) as usize)).unwrap();
        assert!(matches!(
            consume_file(&big),
            Err(Rejected::Dropped(reason)) if reason.contains("oversized")
        ));

        let ok = root.path().join("ok.json");
        fs::write(&ok, envelope(1, "session.bound", "pane-1", "tok", "sid")).unwrap();
        assert_eq!(
            consume_file(&ok).map_err(|_| ()),
            Ok(Inbound::SessionBound(SessionBound {
                pane_id: "pane-1".into(),
                session_id: "sid".into(),
                token: "tok".into(),
                agent: "claude".into(),
                transcript_path: None,
                source: None,
                reporter: None,
            }))
        );

        let gone = root.path().join("missing.json");
        assert!(matches!(consume_file(&gone), Err(Rejected::Transient)));

        // A completed file that can't be READ (non-UTF-8 here) is garbage to
        // consume, not a transient to retry — it gets no further fs events.
        let binary = root.path().join("binary.json");
        fs::write(&binary, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert!(matches!(
            consume_file(&binary),
            Err(Rejected::Dropped(reason)) if reason.contains("unreadable")
        ));
    }
}
