//! The app's doors for the lifecycle handler. The sessions machine's are
//! wired: an exact stop, and the start boundary's cancel. Git and the stores
//! come with their own tasks; until then those doors refuse — and none is
//! reached, since the app does not handshake before integration and the
//! barrier stays up.

use super::Doors;
use crate::session_machine::SessionMachine;
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AttemptId, SessionId, WorkspaceId};
use keepdeck_lifecycle::journal::Ticket;
use keepdeck_lifecycle::machine::Clean;

pub struct AppDoors {
    sessions: SessionMachine,
}

impl AppDoors {
    pub fn new(sessions: SessionMachine) -> AppDoors {
        AppDoors { sessions }
    }
}

fn unwired(what: &str) -> String {
    log::error!("lifecycle: the {what} door is not wired yet");
    format!("the {what} door is not wired yet")
}

impl Doors for AppDoors {
    fn probe(&self, _repo: &Dir, _path: &Dir, _branch: &str) -> bool {
        unwired("place probe");
        true
    }

    fn create_worktree(&self, _ticket: &Ticket) -> Result<(), String> {
        Err(unwired("worktree create"))
    }

    fn read_branches(&self, _repo: &Dir, _path: &Dir) -> Result<Vec<String>, String> {
        Err(unwired("branch read"))
    }

    fn clean(&self, _workspace: &WorkspaceId, _how: &Clean) -> Result<(), String> {
        Err(unwired("cleanup"))
    }

    fn stop(&self, session: SessionId) {
        self.sessions.stop(session);
    }

    fn cancel(&self, attempts: &[AttemptId]) -> Vec<AttemptId> {
        self.sessions.boundary.cancel(attempts)
    }
}
