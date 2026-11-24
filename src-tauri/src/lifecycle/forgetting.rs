//! The lifecycle's answer behind the stores' commit gate: the machine's
//! forgotten set, read from its published state. The machine publishes a
//! step's state before it hands that step's cleanup over, so a write that
//! reads "not forgotten" here lands before the cleanup that removes it.

use super::Door;
use crate::forgotten::{Forgetting, Source};
use keepdeck_lifecycle::domain::ids::{PaneId, TeamId, WorkspaceId};

/// The machine to ask.
pub struct MachineForgetting {
    door: Door,
}

impl MachineForgetting {
    pub fn new(door: Door) -> MachineForgetting {
        MachineForgetting { door }
    }
}

impl Forgetting for MachineForgetting {
    fn forgotten(&self, source: &Source) -> bool {
        let workspace = WorkspaceId(source.workspace.clone());
        let team = source.team.clone().map(TeamId);
        let pane = source.pane.as_deref().and_then(PaneId::parse);
        let states = self.door.machine().state();
        // Copied out, the borrow let go at once: the machine publishes under it.
        let forgotten = states.borrow().value.forgotten.source(&workspace, team.as_ref(), pane.as_ref());
        forgotten
    }
}
