//! The app's doors for the lifecycle handler. The sessions machine's are an
//! exact stop and the start boundary's cancel; git's are worktree.rs's steps
//! under the repository locks the rest of the app takes. The stores come with
//! their own task; until then those cleanup steps refuse — and none is
//! reached, since the app does not handshake before integration and the
//! barrier stays up.

use super::Doors;
use crate::session_machine::SessionMachine;
use crate::worktree::{self, RepoLocks};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AttemptId, SessionId, WorkspaceId};
use keepdeck_lifecycle::journal::Ticket;
use keepdeck_lifecycle::machine::Clean;
use std::path::Path;

pub struct AppDoors {
    sessions: SessionMachine,
    locks: RepoLocks,
}

impl AppDoors {
    pub fn new(sessions: SessionMachine, locks: RepoLocks) -> AppDoors {
        AppDoors { sessions, locks }
    }
}

fn path(dir: &Dir) -> &Path {
    Path::new(dir.as_str())
}

fn unwired(what: &str) -> String {
    log::error!("lifecycle: the {what} door is not wired yet");
    format!("the {what} door is not wired yet")
}

impl Doors for AppDoors {
    fn probe(&self, repo: &Dir, at: &Dir, branch: &str) -> bool {
        worktree::place_taken(path(repo), path(at), branch)
    }

    fn create_worktree(&self, ticket: &Ticket) -> Result<(), String> {
        worktree::create_by_ticket(&self.locks, path(&ticket.repo), path(&ticket.path), &ticket.branch, ticket.base.as_deref())
    }

    fn read_branches(&self, repo: &Dir, at: &Dir) -> Result<Vec<String>, String> {
        worktree::born_branches(&self.locks, path(repo), path(at))
    }

    fn clean(&self, _workspace: &WorkspaceId, how: &Clean) -> Result<(), String> {
        match how {
            Clean::Checkout { repo, path: at } => worktree::remove_planned_checkout(&self.locks, path(repo), path(at)),
            Clean::Branch { repo, name } => worktree::remove_planned_branch(&self.locks, path(repo), name),
            Clean::TagHead { repo, path: at, tag } => worktree::tag_head(path(repo), path(at), tag),
            Clean::Disarm { .. } | Clean::Stores | Clean::Discard { .. } | Clean::Retain { .. } => Err(unwired("store cleanup")),
        }
    }

    fn stop(&self, session: SessionId) {
        self.sessions.stop(session);
    }

    fn cancel(&self, attempts: &[AttemptId]) -> Vec<AttemptId> {
        self.sessions.boundary.cancel(attempts)
    }
}
