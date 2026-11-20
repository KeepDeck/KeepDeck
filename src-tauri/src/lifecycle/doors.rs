//! The app's doors for the lifecycle handler. The sessions machine's are an
//! exact stop and the start boundary's cancel; git's are worktree.rs's steps
//! under the repository locks the rest of the app takes; the stores' are
//! their own port, each store forgetting under its own lock.

use super::{Doors, StoreDoors};
use crate::session_machine::SessionMachine;
use crate::worktree::{self, RepoLocks};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AttemptId, SessionId, WorkspaceId};
use keepdeck_lifecycle::journal::Ticket;
use keepdeck_lifecycle::machine::Clean;
use std::path::Path;
use std::sync::Arc;

pub struct AppDoors {
    sessions: SessionMachine,
    locks: RepoLocks,
    stores: Arc<dyn StoreDoors>,
}

impl AppDoors {
    pub fn new(sessions: SessionMachine, locks: RepoLocks, stores: Arc<dyn StoreDoors>) -> AppDoors {
        AppDoors { sessions, locks, stores }
    }
}

fn path(dir: &Dir) -> &Path {
    Path::new(dir.as_str())
}

impl Doors for AppDoors {
    fn probe(&self, repo: &Dir, at: &Dir, branch: &str) -> bool {
        worktree::place_taken(path(repo), path(at), branch)
    }

    fn create_worktree(&self, ticket: &Ticket) -> Result<(), String> {
        worktree::create_by_ticket(&self.locks, path(&ticket.repo), path(&ticket.path), &ticket.branch, ticket.base.as_deref())
    }

    fn find_worktree(&self, ticket: &Ticket) -> Result<(), String> {
        worktree::find_by_ticket(&self.locks, path(&ticket.repo), path(&ticket.path), &ticket.branch)
    }

    fn read_branches(&self, repo: &Dir, at: &Dir) -> Result<Vec<String>, String> {
        worktree::born_branches(&self.locks, path(repo), path(at))
    }

    fn clean(&self, workspace: &WorkspaceId, how: &Clean) -> Result<(), String> {
        match how {
            Clean::Checkout { repo, path: at } => worktree::remove_planned_checkout(&self.locks, path(repo), path(at)),
            Clean::Branch { repo, name } => worktree::remove_planned_branch(&self.locks, path(repo), name),
            Clean::TagHead { repo, path: at, tag } => worktree::tag_head(path(repo), path(at), tag),
            Clean::Disarm { dir } => self.stores.disarm(dir),
            Clean::Stores => self.stores.forget(workspace),
            Clean::Retain { workspaces } => self.stores.retain(workspaces),
            Clean::Discard { plugin, paths } => self.stores.discard(plugin, paths),
        }
    }

    fn stop(&self, session: SessionId) {
        self.sessions.stop(session);
    }

    fn cancel(&self, attempts: &[AttemptId]) -> Vec<AttemptId> {
        self.sessions.boundary.cancel(attempts)
    }
}
