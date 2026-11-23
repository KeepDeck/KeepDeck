//! The lifecycle machine, running: started on `keepdeck-fsm-runtime` with its
//! handler, on the journal in a folder, behind the waiting door. Whoever
//! builds the app owns the folder's claim and the doors; this starts the
//! machine on them.

use super::door::{Door, Waiters};
use super::handler::Handler;
use super::journal;
use super::store::DiskJournal;
use crate::domain::doors::Doors;
use crate::domain::journal::Entry;
use crate::domain::machine::{update, work, State};
use keepdeck_fsm_runtime::Runtime;
use std::path::Path;
use std::sync::Arc;

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

/// Start a machine on the journal in `root` when it may write there — or
/// view-only, without it: an unreadable journal is not an empty one, and
/// nothing may run as if it were. Call where a tokio runtime is entered.
pub fn start(root: &Path, writes_journal: bool, doors: Arc<dyn Doors>) -> Door {
    let journal = if writes_journal { read_journal(root) } else { None };
    let waiters = Waiters::default();
    let handler = Handler::new(doors, DiskJournal::new(root.to_path_buf()), waiters.clone());
    let machine = Runtime::start(State::start(journal), update, work, handler);
    Door::new(machine, waiters)
}
