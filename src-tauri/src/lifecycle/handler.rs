//! The lifecycle machine's handler: the only one that touches the world for
//! it. Every effect that takes time runs as blocking work under supervision —
//! its outcome, a panic included, comes back to the machine as an event of
//! its own attempt, because the framework recovers nothing.

use super::door::Waiters;
use super::store::DiskJournal;
use keepdeck_fsm_runtime::{Effects, Events};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AttemptId, SessionId, WorkspaceId};
use keepdeck_lifecycle::journal::{self, JournalStore, Ticket};
use keepdeck_lifecycle::machine::{Clean, Effect, Event};
use std::sync::Arc;

/// What the handler asks of the rest of the app: git, the stores, the
/// sessions machine, the spawn door's start boundary.
pub trait Doors: Send + Sync + 'static {
    /// Whether anything is on disk at a candidate place: the folder, or a
    /// branch of that name in the repository.
    fn probe(&self, repo: &Dir, path: &Dir, branch: &str) -> bool;
    /// `git worktree add` by the ticket; a checkout already at the ticket's
    /// path is this ticket's and is picked up.
    fn create_worktree(&self, ticket: &Ticket) -> Result<(), String>;
    /// The branches born in a checkout, from its reflog.
    fn read_branches(&self, repo: &Dir, path: &Dir) -> Result<Vec<String>, String>;
    fn clean(&self, workspace: &WorkspaceId, how: &Clean) -> Result<(), String>;
    /// Ask the sessions machine to stop this exact session.
    fn stop(&self, session: SessionId, quick: bool);
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

/// Blocking work with no cancel: its outcome comes only once it has really
/// ended, and a panic is an outcome too.
async fn supervised<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
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
            Effect::ReadBranches { op, repo, path } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let read = path.clone();
                    let result = supervised(move || doors.read_branches(&repo, &path)).await;
                    Some(Event::BranchesRead { op, path: read, result })
                });
            }
            Effect::Clean { op, workspace, step, how } => {
                let doors = self.doors.clone();
                events.spawn(async move {
                    let result = supervised(move || doors.clean(&workspace, &how)).await;
                    Some(Event::StepDone { op, step, result })
                });
            }
            Effect::Stop { session, quick } => self.doors.stop(session, quick),
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
