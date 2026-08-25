//! The CLI bridge — the channel a pane's own agent process uses to report
//! facts back to KeepDeck (its session id, its usage reports) and to ask, at
//! a turn boundary, whether anything is waiting for it.
//!
//! This module is the composition: serve the surface [`http`] listens on,
//! parse what arrives with [`wire`], emit it. The parts it composes change
//! for different reasons — the wire schema when the deck needs a new field,
//! the run directory when locking or sweeping semantics do — and only the
//! wire half is shared outside the bridge (the session tailer emits the same
//! shapes for what it recovers from transcripts).
//!
//! Transport: an HTTP surface on its own port, published to every pane at
//! spawn through the single `KEEPDECK_BRIDGE` env var. A reporter posts one
//! envelope per message and reads the deck's answer off the same connection.
//!
//! There used to be a second lane: each launch minted a run directory, and
//! reporters dropped files in it that a watcher parsed and consumed. It is
//! gone. Everything it needed to be honest about — a reply written to disk, a
//! timer to see whether anyone collected it, a report that nobody did, and a
//! memory upstairs of what each answer carried so it could be put back — was
//! machinery for one question a connection answers by existing: did the hook
//! get this. What remains of the run directory is a pane-per-directory
//! layout carrying nothing but the doorbell [`nudge`] rings.
//!
//! The bridge is an ephemeral signal bus, not a durable queue. Envelopes are
//! data, never code: size-capped, schema-validated, logged only after control
//! characters are stripped, and carrying a per-spawn token the webview
//! verifies against the pane's own spawn plan before applying anything.

mod http;
mod nudge;
mod rundir;
mod spool;
mod waiters;
mod wire;

use std::fs::{self, File};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

use wire::{printable, Inbound, SESSION_BOUND_EVENT};
// Only what the rest of the crate actually consumes: the session tailer emits
// `Report` on these two event names. `SessionBound` and its event name never
// leave the bridge — a binding is built from an envelope and emitted in the
// same breath, and nothing outside re-emits one.
pub use wire::{Report, AGENT_STATUS_EVENT, USAGE_REPORT_EVENT};

/// An envelope larger than this is refused — reporters send small JSON (a
/// statusline payload runs a few KB; the cap leaves generous headroom for
/// bloated workspace lists), anything bigger is not ours.
const MAX_ENVELOPE_BYTES: u64 = 256 * 1024;

/// This run's live bridge — kept in Tauri managed state so the lock fd and
/// the surface survive for the app's lifetime.
pub struct Bridge {
    /// Where this run's bridge answers, whole. Published to every pane at
    /// spawn — and composed once, so nothing downstream assembles an address
    /// of its own.
    pub url: String,
    /// Hooks parked on an open connection, waiting for the deck's answer.
    /// Shared with the surface: the route parks, `bridge_reply` unparks.
    waiters: std::sync::Arc<waiters::Waiters>,
    /// Held for the run: dropping it would take the surface down.
    _surface: http::Surface,
    /// This run's directory. Panes are given a subdirectory of it at spawn,
    /// and the only thing that lands there now is a doorbell.
    pub run_dir: PathBuf,
    _lock: File,
}

/// Boot the bridge: sweep orphaned run dirs, publish this run's own, serve.
pub fn start(app: &AppHandle) -> Result<Bridge, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for the bridge")?;
    // Pre-bridge installs dropped postbacks into one shared spool; reap it
    // once so it doesn't sit around forever.
    let _ = fs::remove_dir_all(home.join("session-spool"));

    let root = home.join("bridge");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    rundir::restrict(&root);

    let (run_dir, lock, swept) = rundir::boot(&root)?;
    log::info!(
        "bridge: run dir {} (swept {swept} orphaned run dir(s))",
        run_dir.display()
    );

    // Before anything can be spawned: the address has to exist by the time a
    // pane's environment is built, or that pane never learns it — and there
    // is no longer a second lane for one that did not.
    let waiters = std::sync::Arc::new(waiters::Waiters::default());
    let surface = http::serve(app.clone(), std::sync::Arc::clone(&waiters))?;
    log::info!("bridge: surface at {}", surface.url);

    Ok(Bridge {
        url: surface.url.clone(),
        waiters,
        _surface: surface,
        run_dir,
        _lock: lock,
    })
}

/// Answer a hook that is parked on an open connection.
///
/// Returns whether the answer reached it. That single bit is what the file
/// lane could never produce: it wrote to disk and had to wait out a window
/// before guessing whether anyone had come. Here the send either finds the
/// asker or does not, at the moment it happens — so the deck learns
/// immediately that a batch it took out of a queue went nowhere, and can put
/// it back while it is still the only thing that has it.
///
/// The pane is half the address. An answer names both the pane that asked and
/// the correlation it asked on, so an envelope carrying another pane's
/// correlation cannot reach that pane's hook.
#[tauri::command]
pub fn bridge_reply(
    bridge: tauri::State<Bridge>,
    pane: String,
    id: String,
    body: String,
) -> bool {
    bridge.waiters.resolve(&pane, &id, body)
}

/// The directory one pane's reporters watch, created here so it exists before
/// the agent does.
///
/// Handed out at spawn and put in that pane's `KEEPDECK_BRIDGE`, so a
/// reporter needs no knowledge of the layout — it watches where it was told.
/// Errors are surfaced: a spawn whose reporters have nowhere to look should
/// be armed without a bridge rather than armed with a path that does not
/// exist, and only the caller can make that choice.
#[tauri::command]
pub fn bridge_pane_dir(bridge: tauri::State<Bridge>, pane: String) -> Result<String, String> {
    spool::pane_dir(&bridge.run_dir, &pane).map(|dir| dir.to_string_lossy().into_owned())
}

/// Tell a pane's own in-process reporter that mail is waiting for it.
///
/// The terminal equivalent of this types a line into the pane. That is the
/// floor every CLI can meet, not the goal: an agent whose reporter runs
/// inside its own process can be told directly, and then nothing KeepDeck
/// does ever appears in front of the model as if the user had typed it.
///
/// This is the one thing still travelling as a file, and it travels that way
/// because it runs the OTHER direction: the surface takes envelopes from
/// panes, it does not push to them. A doorbell is the deck knocking, and
/// nothing on the connection can knock.
///
/// Fire-and-forget by design. Whether anybody is listening is not a fact this
/// side can observe — the reporter answers by ASKING, on its own connection —
/// and a pane that never asks lets its mail expire and be reported back to
/// the sender. Guessing here would only add a second story.
#[tauri::command]
pub fn bridge_nudge(bridge: tauri::State<Bridge>, pane: String) {
    match nudge::ring(&bridge.run_dir, &pane) {
        Ok(()) => log::info!("bridge: nudged pane={}", printable(&pane)),
        Err(e) => log::warn!("bridge: {e}"),
    }
}

/// One interpreted envelope → one event.
///
/// Kept apart from the route that calls it because the two answer different
/// questions: the route knows how bytes arrive, this knows what a report
/// MEANS. That separation is what let the file lane be removed without
/// anything downstream noticing.
fn emit_inbound(app: &AppHandle, inbound: Inbound) {
    match inbound {
        Inbound::SessionBound(bound) => {
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
        Inbound::Opaque { event, report } => {
            log::debug!("bridge: {event} pane={}", printable(&report.pane_id));
            if let Err(e) = app.emit(event, &report) {
                log::warn!("bridge: emitting {event} failed: {e}");
            }
        }
    }
}
