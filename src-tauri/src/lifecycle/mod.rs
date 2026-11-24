//! The lifecycle machine in the app: started once at app setup, on the
//! journal root's claim, and held in the app's managed state for the app's
//! whole life. The machine, its handler, the journal on disk and the waiting
//! door are the `keepdeck-lifecycle` crate's; this module is the doors that
//! reach the rest of the app, and the IPC commands.
//!
//! The claim is the one [`crate::single`] took before anything else ran: a
//! second copy on the same settings folder never gets this far, so there is
//! one machine for the app's life and nothing ever swaps it.

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
use crate::single::Owned;
use keepdeck_lifecycle::domain::doors::Doors;
use keepdeck_lifecycle::infrastructure::door::Door;
use keepdeck_lifecycle::infrastructure::machine;
use std::sync::Arc;

/// The running machine, in the app's managed state, with the claim it runs
/// on. Not `Clone`: the claim is held once. What needs the machine apart
/// from the managed state holds its [`Door`].
pub struct Lifecycle {
    door: Door,
    doors: Arc<dyn Doors>,
    claim: ClaimedRoot,
}

impl Lifecycle {
    /// Start the machine on the home this copy owns: the journal root its
    /// claim holds, and the journal read from it at the door. Call where a
    /// tokio runtime is entered.
    pub fn start(doors: Arc<dyn Doors>, home: Owned) -> Lifecycle {
        let Owned { claim, journal } = home;
        let door = machine::start(claim.root(), fs_claim::LOCK_FILE, journal, doors.clone());
        Lifecycle { door, doors, claim }
    }

    /// The machine's door.
    pub fn door(&self) -> Door {
        self.door.clone()
    }

    pub fn doors(&self) -> Arc<dyn Doors> {
        self.doors.clone()
    }

    /// This copy was asked to restart: its lock says it is leaving, so the
    /// copy that replaces it waits for it to go rather than yield to it.
    pub fn leaving(&self) {
        self.claim.set_leaving();
    }
}
