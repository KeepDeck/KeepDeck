//! The CLI bridge — the one-way channel a pane's own agent process uses to
//! report facts back to KeepDeck (today: its session id, [F7]/[F8] identity).
//!
//! Transport: a per-RUN inbox directory. Each launch mints
//! `<keepdeck_home>/bridge/run-<uuid>/`, holds an OS file lock on `lock`
//! inside it for the process's lifetime, and watches for `*.json` envelope
//! drops. Reporters (hook/plugin shipped with KeepDeck, armed per spawn via
//! the single `KEEPDECK_BRIDGE` env var) write one uniquely-named file per
//! message — tmp + rename, so the watcher never sees a torn file — and the
//! watcher parses, emits and consumes it.
//!
//! Per-run dirs mean two KeepDeck instances never share an inbox. Orphans
//! from crashed runs are swept at boot by probing their locks: the kernel
//! releases a dead process's lock unconditionally, so "lock acquirable" ==
//! "owner dead" — no PID files, no age heuristics. A new inbox is built
//! under `.staging/` and lock-acquired BEFORE the atomic rename publishes
//! it, so a concurrently booting sweeper can never catch a live inbox
//! unlocked.
//!
//! The bridge is an ephemeral signal bus, not a durable queue: every run
//! starts with a fresh empty inbox and whatever a dead run left is deleted
//! unread. Envelopes are data, never code: size-capped, schema-validated,
//! logged only after control characters are stripped, and carrying a
//! per-spawn token the webview verifies against the pane's own spawn plan
//! before applying anything.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Bridge protocol version — covers the `KEEPDECK_BRIDGE` env schema AND the
/// envelope schema, incremented on ANY change to either (a plain change
/// counter, plugin-API style). The host accepts the versions it supports;
/// everything else is logged and consumed.
pub const BRIDGE_PROTOCOL_VERSION: u64 = 1;

/// Event delivering one session binding to the webview (`src/ipc/sessions.ts`).
pub const SESSION_BOUND_EVENT: &str = "deck://session/bound";

/// An envelope larger than this is dropped unread — reporters send tiny
/// JSON, anything bigger is not ours.
const MAX_ENVELOPE_BYTES: u64 = 64 * 1024;

/// The staging area inboxes are built (and locked) in before publication.
const STAGING_DIR: &str = ".staging";

/// The lock file a live instance holds inside its run dir.
const LOCK_FILE: &str = "lock";

/// The root-wide lock serializing boot (sweep + publish) across instances.
const BOOT_LOCK: &str = ".boot-lock";

/// One message dropped into the inbox. Unknown fields are ignored so
/// reporters may attach diagnostics.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    /// The protocol version the WRITER speaks.
    v: u64,
    /// Message type — the dispatch key.
    #[serde(rename = "type")]
    kind: String,
    /// Correlation: the pane whose spawn armed the reporter.
    #[serde(default)]
    pane_id: String,
    /// Per-spawn secret echoed back by the reporter.
    #[serde(default)]
    token: String,
    /// Type-specific body.
    #[serde(default)]
    payload: serde_json::Value,
}

/// The `session.bound` wire event (see `src/ipc/sessions.ts`). The webview
/// verifies `token` against the pane's spawn plan before binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBound {
    pub pane_id: String,
    pub session_id: String,
    pub token: String,
}

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
    restrict(&root);

    let (run_dir, lock, swept) = boot(&root)?;
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

/// Owner-only permissions — other users never see the inbox. Best-effort:
/// the home is usually 0700 already.
fn restrict(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
}

/// Sweep, then publish this run's inbox — under a root-wide boot lock, so
/// the two are one atomic step ACROSS instances. The per-inbox lock cannot
/// cover the moment before it exists (a dir is created before its lock
/// file), which is exactly the window where a concurrently booting sweeper
/// could eat a sibling's half-built staging dir. The gate is held for
/// microseconds and the kernel releases it even on a crash. Expects `root`
/// to exist.
fn boot(root: &Path) -> Result<(PathBuf, File, usize), String> {
    let gate = File::create(root.join(BOOT_LOCK)).map_err(|e| e.to_string())?;
    gate.lock()
        .map_err(|e| format!("bridge boot lock failed: {e:?}"))?;
    let swept = sweep_orphans(root);
    let (run_dir, lock) = create_run_dir(root)?;
    Ok((run_dir, lock, swept))
    // `gate` drops here — boot section over, the next instance may proceed.
}

/// Build this run's inbox under `.staging/`, take its lock THERE, then
/// atomically rename it into the root. Publication happens already-locked,
/// so a sweeper OUTSIDE the boot gate (there are none today — sweeping only
/// happens inside `boot`) could still never mistake a published live inbox
/// for an orphan.
fn create_run_dir(root: &Path) -> Result<(PathBuf, File), String> {
    let staging = root.join(STAGING_DIR);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let name = format!("run-{}", uuid::Uuid::new_v4());
    let staged = staging.join(&name);
    fs::create_dir(&staged).map_err(|e| e.to_string())?;
    restrict(&staged);
    let lock = File::create(staged.join(LOCK_FILE)).map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|e| format!("locking a fresh inbox failed: {e:?}"))?;
    let run_dir = root.join(&name);
    fs::rename(&staged, &run_dir).map_err(|e| e.to_string())?;
    Ok((run_dir, lock))
}

/// Delete inboxes whose owners are gone, in the root and in `.staging`.
/// Returns how many were swept.
fn sweep_orphans(root: &Path) -> usize {
    let mut swept = 0;
    for base in [root.to_path_buf(), root.join(STAGING_DIR)] {
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        // Only dirs are probed — the boot-lock FILE at the root is skipped
        // by the is_dir check below.
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.file_name().is_some_and(|n| n == STAGING_DIR) {
                continue;
            }
            if is_orphan(&path) && fs::remove_dir_all(&path).is_ok() {
                swept += 1;
            }
        }
    }
    swept
}

/// A dir is an orphan when nobody holds its lock. A live owner ALWAYS holds
/// one (taken before publication); the kernel releases it on any process
/// death. Busy — or unprobeable — locks leave the dir alone: deleting a live
/// instance's inbox is the one unacceptable failure mode.
fn is_orphan(dir: &Path) -> bool {
    match File::open(dir.join(LOCK_FILE)) {
        // No lock file at all: a torn boot's leftovers (the rename that
        // publishes a live inbox only ever runs after its lock exists).
        Err(_) => true,
        Ok(file) => file.try_lock().is_ok(),
    }
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
        Ok(bound) => {
            log::info!(
                "bridge: bound pane={} session={}",
                printable(&bound.pane_id),
                printable(&bound.session_id),
            );
            if let Err(e) = app.emit(SESSION_BOUND_EVENT, &bound) {
                log::warn!("bridge: emitting {SESSION_BOUND_EVENT} failed: {e}");
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
fn consume_file(path: &Path) -> Result<SessionBound, Rejected> {
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

/// Parse and dispatch one envelope. The bridge is fed by shell hooks, so
/// anything malformed degrades to a logged reason, never an error path.
fn interpret(content: &str) -> Result<SessionBound, String> {
    let envelope: Envelope =
        serde_json::from_str(content).map_err(|_| "not an envelope".to_string())?;
    if envelope.v != BRIDGE_PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version {}", envelope.v));
    }
    match envelope.kind.as_str() {
        "session.bound" => {
            let session_id = envelope
                .payload
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if envelope.pane_id.is_empty() || envelope.token.is_empty() || session_id.is_empty() {
                return Err("session.bound with empty fields".into());
            }
            Ok(SessionBound {
                pane_id: envelope.pane_id,
                session_id: session_id.to_string(),
                token: envelope.token,
            })
        }
        other => Err(format!("unknown type \"{}\"", printable(other))),
    }
}

/// Reporter-supplied strings are untrusted — strip control characters and
/// cap length before they reach a log line.
fn printable(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(v: u64, kind: &str, pane: &str, token: &str, session: &str) -> String {
        serde_json::json!({
            "v": v, "type": kind, "paneId": pane, "token": token,
            "payload": { "sessionId": session },
        })
        .to_string()
    }

    #[test]
    fn interprets_a_session_bound_envelope_ignoring_extras() {
        let mut value: serde_json::Value =
            serde_json::from_str(&envelope(1, "session.bound", "pane-3", "tok", "abc")).unwrap();
        value["agent"] = "codex".into();
        value["payload"]["transcriptPath"] = "/x/y.jsonl".into();
        assert_eq!(
            interpret(&value.to_string()),
            Ok(SessionBound {
                pane_id: "pane-3".into(),
                session_id: "abc".into(),
                token: "tok".into(),
            })
        );
    }

    #[test]
    fn rejects_unsupported_versions_and_unknown_types() {
        assert!(interpret(&envelope(2, "session.bound", "p", "t", "s"))
            .is_err_and(|e| e.contains("version 2")));
        assert!(interpret(&envelope(1, "session.stopped", "p", "t", "s"))
            .is_err_and(|e| e.contains("session.stopped")));
    }

    #[test]
    fn rejects_garbage_and_empty_fields() {
        assert!(interpret("not json").is_err());
        assert!(interpret("{}").is_err());
        assert!(interpret(&envelope(1, "session.bound", "", "t", "s")).is_err());
        assert!(interpret(&envelope(1, "session.bound", "p", "", "s")).is_err());
        assert!(interpret(&envelope(1, "session.bound", "p", "t", "")).is_err());
    }

    // The webview listens for this exact wire shape — pin it.
    #[test]
    fn session_bound_serializes_camel_case() {
        let json = serde_json::to_value(SessionBound {
            pane_id: "pane-3".into(),
            session_id: "abc".into(),
            token: "tok".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "paneId": "pane-3", "sessionId": "abc", "token": "tok" })
        );
    }

    #[test]
    fn log_strings_lose_control_characters() {
        assert_eq!(printable("a\x1b[31mb\nc"), "a[31mbc");
    }

    #[test]
    fn a_fresh_inbox_is_published_locked_with_empty_staging() {
        let root = tempfile::tempdir().unwrap();
        let (dir, _lock) = create_run_dir(root.path()).unwrap();
        assert!(
            dir.parent().unwrap() == root.path(),
            "published into the root"
        );
        assert!(dir.join(LOCK_FILE).is_file());
        // The staging area kept nothing behind.
        let staged: Vec<_> = fs::read_dir(root.path().join(STAGING_DIR))
            .unwrap()
            .collect();
        assert!(staged.is_empty());
        // And the lock is genuinely held: a probe must NOT call it an orphan.
        assert!(!is_orphan(&dir));
    }

    #[test]
    fn sweep_removes_dead_inboxes_and_spares_live_ones() {
        let root = tempfile::tempdir().unwrap();
        // A live inbox: lock held by this process.
        let (live, _held) = create_run_dir(root.path()).unwrap();
        // A dead inbox: lock file exists but nobody holds it.
        let dead = root.path().join("run-dead");
        fs::create_dir(&dead).unwrap();
        File::create(dead.join(LOCK_FILE)).unwrap();
        // A torn staging leftover: no lock file was ever created.
        let torn = root.path().join(STAGING_DIR).join("run-torn");
        fs::create_dir_all(&torn).unwrap();
        // A stray file in the root must simply be skipped.
        fs::write(root.path().join("stray.txt"), "x").unwrap();

        assert_eq!(sweep_orphans(root.path()), 2);
        assert!(live.is_dir(), "live inbox survives");
        assert!(!dead.exists(), "dead inbox swept");
        assert!(!torn.exists(), "torn staging leftover swept");
        assert!(root.path().join("stray.txt").is_file());
    }

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
            Ok(SessionBound {
                pane_id: "pane-1".into(),
                session_id: "sid".into(),
                token: "tok".into(),
            })
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

    #[test]
    fn concurrent_boots_never_eat_each_other() {
        // Regression for the boot race: a sweeping instance must never
        // observe (and delete) a sibling's half-built staging dir. The boot
        // gate serializes sweep+publish, so every one of these succeeds and
        // every published inbox stays alive.
        let root = tempfile::tempdir().unwrap();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let root = root.path().to_path_buf();
                std::thread::spawn(move || boot(&root))
            })
            .collect();
        let live: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().unwrap().expect("every boot succeeds"))
            .collect();
        assert_eq!(live.len(), 8);
        for (dir, _lock, _swept) in &live {
            assert!(dir.is_dir(), "published inbox survives: {}", dir.display());
            assert!(!is_orphan(dir));
        }
    }
}
