//! The lifecycle machine's handler: the only one that touches the world for
//! it. Every effect that takes time runs as blocking work under supervision —
//! its outcome, a panic included, comes back to the machine as an event of
//! its own attempt, because the framework recovers nothing.

use super::door::Waiters;
use super::store::DiskJournal;
use keepdeck_fsm_runtime::{Effects, Events};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AttemptId, SessionId};
use keepdeck_lifecycle::journal::{self, JournalStore, Ticket};
use keepdeck_lifecycle::machine::{Clean, Effect, Event};
use std::sync::Arc;
use std::time::Duration;

/// What the handler asks of the rest of the app: git, the stores, the
/// sessions machine, the spawn door's start boundary.
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

pub struct Handler {
    doors: Arc<dyn Doors>,
    journal: DiskJournal,
    waiters: Waiters,
}

impl Handler {
    pub fn new(doors: Arc<dyn Doors>, journal: DiskJournal, waiters: Waiters) -> Handler {
        Handler { doors, journal, waiters }
    }
}

/// How long a store's cleanup may take before its step is left owed.
const STORE_CLEAN_LIMIT: Duration = Duration::from_secs(30);

/// A cleanup step's clock. Git's steps have none, like every git command
/// that provisions — a large tree takes as long as it takes. A store's
/// forgetting waits on that store's lock behind its writers: past its limit
/// the step is left owed for the next launch, never counted as done.
fn clean_limit(how: &Clean) -> Option<Duration> {
    match how {
        Clean::Checkout { .. } | Clean::Branch { .. } | Clean::TagHead { .. } => None,
        Clean::Disarm { .. } | Clean::Stores { .. } | Clean::Retain { .. } | Clean::Discard { .. } => Some(STORE_CLEAN_LIMIT),
    }
}

/// `work`, or a refusal once `limit` has passed. The work itself is not
/// cancelled: blocking work cannot be, and what it still does lands under
/// its store's lock like any write, to be found by the retry.
async fn bounded<T>(limit: Option<Duration>, work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    match limit {
        None => work.await,
        Some(limit) => tokio::time::timeout(limit, work)
            .await
            .unwrap_or_else(|_| Err(format!("not done within {} s; left owed", limit.as_secs()))),
    }
}

/// Blocking work with no cancel: its outcome comes only once it has really
/// ended, and a panic is an outcome too. Shared by every machine's handler.
pub(crate) async fn supervised<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => Err("the work panicked".into()),
        Err(_) => Err("the work was cancelled".into()),
    }
}

impl Effects<Effect, Event> for Handler {
    fn run(&mut self, effect: Effect, events: &Events<Event>) {
        match effect {
            Effect::Answer { ask, answer } => self.waiters.deliver(ask, answer),
            Effect::WriteJournal { op, attempt, entry } => {
                let mut store = self.journal.clone();
                events.spawn(async move {
                    let result = supervised(move || {
                        store.write(&journal::file_name(op), &journal::encode(&entry)).map_err(|e| e.to_string())
                    })
                    .await;
                    Some(Event::JournalWritten { op, attempt, result })
                });
            }
            Effect::RemoveJournal { op, attempt } => {
                let mut store = self.journal.clone();
                events.spawn(async move {
                    let result = supervised(move || store.remove(&journal::file_name(op)).map_err(|e| e.to_string())).await;
                    Some(Event::JournalRemoved { op, attempt, result })
                });
            }
            Effect::Probe { op, repo, path, branch } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let probed = path.clone();
                    // A probe that fails says the place is taken: it is never
                    // handed out on a guess.
                    let taken = supervised(move || Ok(doors.probe(&repo, &path, &branch))).await.unwrap_or(true);
                    Some(Event::Probed { op, path: probed, taken })
                });
            }
            Effect::CreateWorktree { op, ticket } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let result = supervised(move || doors.create_worktree(&ticket)).await;
                    Some(Event::Created { op, result })
                });
            }
            Effect::FindWorktree { op, ticket } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let found = supervised(move || doors.find_worktree(&ticket)).await;
                    Some(Event::Found { op, found })
                });
            }
            Effect::ReadBranches { op, repo, path } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let read = path.clone();
                    let result = supervised(move || doors.read_branches(&repo, &path)).await;
                    Some(Event::BranchesRead { op, path: read, result })
                });
            }
            Effect::Clean { op, step, how } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let limit = clean_limit(&how);
                    let result = bounded(limit, supervised(move || doors.clean(&how))).await;
                    Some(Event::StepDone { op, step, result })
                });
            }
            Effect::Stop { session } => self.doors.stop(session),
            Effect::Cancel { op, attempts } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    // A cancel that fails cannot say a process never started:
                    // every attempt is taken as started, and stopped by id.
                    let fallback = attempts.clone();
                    let started = supervised(move || Ok(doors.cancel(&attempts))).await.unwrap_or(fallback);
                    Some(Event::Cancelled { op, started })
                });
            }
            Effect::Warn { message } => log::warn!("lifecycle: {message}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_lifecycle::ids::WorkspaceId;

    #[tokio::test(start_paused = true)]
    async fn a_store_cleanup_past_its_limit_is_left_owed_and_a_git_step_has_no_clock() {
        let stuck = || std::future::pending::<Result<(), String>>();
        let stores = Clean::Stores { workspace: WorkspaceId("ws-a".into()) };
        let late = bounded(clean_limit(&stores), stuck()).await;
        assert!(late.unwrap_err().contains("left owed"));
        assert_eq!(bounded(clean_limit(&stores), async { Ok(()) }).await, Ok(()));
        let checkout = Clean::Checkout { repo: Dir::new("/repo"), path: Dir::new("/wt") };
        assert_eq!(clean_limit(&checkout), None);
        let slow_git = tokio::time::timeout(STORE_CLEAN_LIMIT * 10, bounded(None, stuck())).await;
        assert!(slow_git.is_err(), "still waited on, long past any store's limit");
    }
}
