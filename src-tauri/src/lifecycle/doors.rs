//! The app's doors for the lifecycle handler. Until the doors are wired
//! (git, the stores, the sessions machine), none of them runs: the app never
//! handshakes before integration, so the barrier stays up and the machine
//! hands out no effect that would reach here.

use super::Doors;
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AttemptId, SessionId, WorkspaceId};
use keepdeck_lifecycle::journal::Ticket;
use keepdeck_lifecycle::machine::Clean;

pub struct AppDoors;

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

    fn stop(&self, _session: SessionId, _quick: bool) {
        unwired("session stop");
    }

    fn cancel(&self, attempts: &[AttemptId]) -> Vec<AttemptId> {
        unwired("start boundary");
        attempts.to_vec()
    }
}
