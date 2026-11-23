//! What the lifecycle needs from the world beyond its own journal: git, the
//! stores, the sessions machine and the spawn door's start boundary. The
//! machine asks for each as an effect; its handler carries the effect out
//! through this port, and the app implements it — every door reaches another
//! feature.

use super::dir::Dir;
use super::ids::{AttemptId, SessionId};
use super::journal::Ticket;
use super::machine::Clean;

pub trait Doors: Send + Sync + 'static {
    /// Whether anything is on disk at a candidate place: the folder, or a
    /// branch of that name in the repository.
    fn probe(&self, repo: &Dir, path: &Dir, branch: &str) -> bool;
    /// `git worktree add` by the ticket; a checkout already at the ticket's
    /// path is this ticket's and is picked up.
    fn create_worktree(&self, ticket: &Ticket) -> Result<(), String>;
    /// Whether the ticket's checkout stands at its path on its branch;
    /// nothing is made. An error only when git could not read the
    /// repository.
    fn find_worktree(&self, ticket: &Ticket) -> Result<bool, String>;
    /// The branches born in a checkout, from its reflog.
    fn read_branches(&self, repo: &Dir, path: &Dir) -> Result<Vec<String>, String>;
    fn clean(&self, how: &Clean) -> Result<(), String>;
    /// Ask the sessions machine to stop this exact session.
    fn stop(&self, session: SessionId);
    /// Cancel admitted launches at the start boundary; answers those whose
    /// process already exists.
    fn cancel(&self, attempts: &[AttemptId]) -> Vec<AttemptId>;
}
