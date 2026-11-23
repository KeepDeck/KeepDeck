//! The lifecycle machine in the app: started once at app setup, held in the
//! app's managed state for the app's whole life. The machine, its handler,
//! the journal on disk and the waiting door are the `keepdeck-lifecycle`
//! crate's; this module is the journal folder's claim, the doors that reach
//! the rest of the app, and the IPC commands.
//!
//! The machine runs only with the journal root's claim. Without it — another
//! KeepDeck holds this settings folder — it starts view-only, and the claim is
//! tried again until it is had; then the machine starts over from the deck
//! and the journal, and TS is told to handshake again.

mod commands;
mod doors;
mod forgetting;
mod stores;
#[cfg(test)]
mod tests;

pub use commands::*;
pub use doors::AppDoors;
pub use forgetting::MachineForgetting;
pub use stores::{AppStores, StoreDoors};

use crate::fs_claim::{self, ClaimedRoot};
use keepdeck_lifecycle::domain::doors::Doors;
use keepdeck_lifecycle::infrastructure::door::Door;
use keepdeck_lifecycle::infrastructure::machine;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

/// How often a copy without the journal root's claim tries for it again.
const CLAIM_RETRY: Duration = Duration::from_secs(2);

/// What TS hears when the machine starts over with the claim it got late.
pub const RESTARTED: &str = "lifecycle://restarted";

struct Live {
    door: Door,
    claim: Option<ClaimedRoot>,
}

/// The running machine, in the app's managed state. A clone is a hold on the
/// same machine — the one in place now, whichever that is after a claim won
/// late — for what needs it before, or apart from, the managed state.
#[derive(Clone)]
pub struct Lifecycle {
    live: Arc<Mutex<Live>>,
    doors: Arc<dyn Doors>,
    root: PathBuf,
}

impl Lifecycle {
    /// Take the journal root's claim and start the machine on it.
    pub fn start_at(root: PathBuf, doors: Arc<dyn Doors>) -> Lifecycle {
        let claim = match fs_claim::claim(&root, "lifecycle journal") {
            Ok(claim) => Some(claim),
            Err(error) => {
                log::warn!("lifecycle: {error}; this copy only shows until it has the claim");
                None
            }
        };
        let door = machine::start(&root, fs_claim::LOCK_FILE, claim.is_some(), doors.clone());
        Lifecycle { live: Arc::new(Mutex::new(Live { door, claim })), doors, root }
    }

    /// The door of the machine in place now. Had without fail — a poisoned
    /// lock still holds a whole door — since the sessions' watcher asks for
    /// it as its own panic unwinds, where a second panic aborts the app.
    pub fn door(&self) -> Door {
        self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).door.clone()
    }

    pub fn doors(&self) -> Arc<dyn Doors> {
        self.doors.clone()
    }

    pub fn claimed(&self) -> bool {
        self.live.lock().expect("lifecycle").claim.is_some()
    }

    /// The machine now in place still runs: its task has not ended.
    pub fn running(&self) -> bool {
        self.door().machine().state().has_changed().is_ok()
    }

    /// Without the claim: try for it again until it is had, then start over
    /// and tell TS.
    pub fn retry_claim<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
        tauri::async_runtime::spawn(async move {
            loop {
                use tauri::Manager;
                let lifecycle = app.state::<Lifecycle>();
                if lifecycle.claimed() {
                    return;
                }
                tokio::time::sleep(CLAIM_RETRY).await;
                let Ok(claim) = fs_claim::claim(&lifecycle.root, "lifecycle journal") else { continue };
                let door = machine::start(&lifecycle.root, fs_claim::LOCK_FILE, true, lifecycle.doors.clone());
                *lifecycle.live.lock().expect("lifecycle") = Live { door, claim: Some(claim) };
                log::info!("lifecycle: the journal root is this copy's now; starting over");
                let _ = app.emit(RESTARTED, ());
                return;
            }
        });
    }
}

/// The journal root: `<keepdeck home>/lifecycle`.
pub fn journal_root() -> Option<PathBuf> {
    crate::paths::keepdeck_home().map(|home| home.join("lifecycle"))
}
