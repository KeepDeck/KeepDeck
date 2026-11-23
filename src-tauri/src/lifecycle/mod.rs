//! The lifecycle machine, running: started once at app setup on
//! `keepdeck-fsm-runtime`, held in the app's managed state for the app's whole
//! life. Its rules are the `keepdeck-lifecycle` crate's; this module is its
//! journal on disk, its handler, the waiting door and the IPC commands.
//!
//! The machine runs only with the journal root's claim. Without it — another
//! KeepDeck holds this settings folder — it starts view-only, and the claim is
//! tried again until it is had; then the machine starts over from the deck
//! and the journal, and TS is told to handshake again.

mod commands;
mod door;
mod doors;
mod forgetting;
mod handler;
mod store;
mod stores;
#[cfg(test)]
mod tests;

pub use commands::*;
pub use door::Door;
pub use doors::AppDoors;
pub use forgetting::MachineForgetting;
pub use stores::{AppStores, StoreDoors};
pub use handler::Doors;

use crate::fs_claim::{self, ClaimedRoot};
use door::Waiters;
use handler::Handler;
use keepdeck_fsm_runtime::Runtime;
use keepdeck_lifecycle::journal::{self, Entry};
use keepdeck_lifecycle::machine::{update, work, State};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::DiskJournal;
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

/// The journal of `root`: every readable entry; every other file is logged
/// with its content and removed. None when the folder cannot be read at all.
fn read_journal(root: &Path) -> Option<Vec<Entry>> {
    let mut store = DiskJournal::new(root.to_path_buf());
    match journal::load(&mut store) {
        Ok(loaded) => {
            for dropped in &loaded.dropped {
                log::error!(
                    "lifecycle: journal file {} is not replayed ({:?}); removed: {:?}; content: {}",
                    dropped.name,
                    dropped.why,
                    dropped.removed,
                    dropped.raw
                );
            }
            Some(loaded.entries)
        }
        Err(error) => {
            log::error!("lifecycle: the journal at {} could not be read: {error}", root.display());
            None
        }
    }
}

/// Start a machine on the journal it may write — or view-only, without one:
/// an unreadable journal is not an empty one, and nothing may run as if it
/// were. Call where a tokio runtime is entered.
fn start_machine(root: &Path, claimed: bool, doors: Arc<dyn Doors>) -> Door {
    let journal = if claimed { read_journal(root) } else { None };
    let waiters = Waiters::default();
    let handler = Handler::new(doors, DiskJournal::new(root.to_path_buf()), waiters.clone());
    let machine = Runtime::start(State::start(journal), update, work, handler);
    Door::new(machine, waiters)
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
        let door = start_machine(&root, claim.is_some(), doors.clone());
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
                let door = start_machine(&lifecycle.root, true, lifecycle.doors.clone());
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
