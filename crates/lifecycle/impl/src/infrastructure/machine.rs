//! The lifecycle machine, running: started on `keepdeck-fsm-runtime` with its
//! handler, on the journal in a folder, behind the waiting door. Whoever
//! builds the app owns the folder's claim and the doors; this starts the
//! machine on them.

use super::door::{Door, Waiters};
use super::handler::Handler;
use super::journal::DiskJournal;
pub use super::journal::Loaded;
use crate::domain::doors::Doors;
use crate::domain::machine::{update, work, State};
use keepdeck_fsm_runtime::Runtime;
use std::path::Path;
use std::sync::Arc;

/// Read the journal in `root`: every readable entry, and every other file —
/// removed already — with its content. An error when the folder cannot be
/// read at all: an unreadable journal is not an empty one, and nothing may
/// start as if it were. `lock` is the file of the folder's claim, named by
/// whoever holds the claim: it is no entry. Read once, by whoever holds the
/// claim, and handed to [`start`]: a second read would find nothing of what
/// the first one removed.
pub fn load_journal(root: &Path, lock: &str) -> std::io::Result<Loaded> {
    DiskJournal::new(root.to_path_buf(), lock).load()
}

/// Start the machine on `journal`, read from `root` by [`load_journal`]. The
/// files that read dropped are logged here, where the log is up: their
/// content is the only record left of them. Call where a tokio runtime is
/// entered.
pub fn start(root: &Path, lock: &str, journal: Loaded, doors: Arc<dyn Doors>) -> Door {
    for dropped in &journal.dropped {
        log::error!(
            "lifecycle: journal file {} is not replayed ({:?}); removed: {:?}; content: {}",
            dropped.name,
            dropped.why,
            dropped.removed,
            dropped.raw
        );
    }
    let disk = DiskJournal::new(root.to_path_buf(), lock);
    let waiters = Waiters::default();
    let handler = Handler::new(doors, disk, waiters.clone());
    let machine = Runtime::start(State::start(journal.entries), update, work, handler);
    Door::new(machine, waiters)
}

/// The machine on its real runtime, handler, journal on disk and waiting
/// door, with fake doors for git, the stores and the sessions machine.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::command::{Cmd, Outcome, Owner, Revision};
    use crate::domain::dir::Dir;
    use crate::domain::ids::{AttemptId, PaneId, SessionId, TeamId, WorkspaceId};
    use crate::domain::journal::Ticket;
    use crate::domain::machine::snapshot::snapshot;
    use crate::domain::machine::{Clean, Event, Load};
    use crate::domain::model::{Answer, Consent, Draft, Intent, Place, Refusal, Reply, Site};
    use crate::domain::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};
    use std::sync::Mutex;
    use std::time::Duration;

    /// The claim's lock file, as the app names it.
    const LOCK_FILE: &str = "lock";

    /// Doors that do what is asked, or panic where a test makes them.
    #[derive(Default)]
    struct FakeDoors {
        cleaned: Mutex<Vec<Clean>>,
        panic_on_clean: bool,
        panic_on_probe: bool,
    }

    impl Doors for FakeDoors {
        fn probe(&self, _repo: &Dir, _path: &Dir, _branch: &str) -> bool {
            if self.panic_on_probe {
                panic!("a probe that cannot look");
            }
            false
        }
        fn create_worktree(&self, _ticket: &Ticket) -> Result<(), String> {
            Ok(())
        }
        fn find_worktree(&self, _ticket: &Ticket) -> Result<bool, String> {
            Ok(true)
        }
        fn read_branches(&self, _repo: &Dir, _path: &Dir) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn clean(&self, how: &Clean) -> Result<(), String> {
            if self.panic_on_clean {
                panic!("a door that panics");
            }
            self.cleaned.lock().unwrap().push(how.clone());
            Ok(())
        }
        fn stop(&self, _session: SessionId) {}
        fn cancel(&self, _attempts: &[AttemptId]) -> Vec<AttemptId> {
            Vec::new()
        }
    }

    fn ws() -> WorkspaceId {
        WorkspaceId("ws-a".into())
    }

    fn deck() -> DeckFacts {
        DeckFacts {
            workspaces: vec![WorkspaceFacts {
                id: ws(),
                name: "app".into(),
                cwd: Dir::new("/repo"),
                worktree_base: Some(Dir::new("/wt")),
                archived: false,
                archiving: false,
                repo: None,
                teams: vec![TeamFacts { id: TeamId("team-r".into()), at: TeamAtFacts::Attached { cwd: Dir::new("/repo"), branch: None } }],
                panes: vec![
                    PaneFacts { id: PaneId(1), team: Some(TeamId("team-r".into())), remote: false, suspended: false },
                    PaneFacts { id: PaneId(2), team: Some(TeamId("team-r".into())), remote: false, suspended: false },
                ],
            }],
        }
    }

    async fn handshake(door: &Door) -> Reply {
        door.ask(|ask| Event::Handshake { ask, deck: deck(), load: Load::Loaded }).await
    }

    async fn booted(root: &Path, doors: Arc<FakeDoors>) -> Door {
        let door = start(root, LOCK_FILE, load_journal(root, LOCK_FILE).expect("the journal"), doors);
        let reply = handshake(&door).await;
        assert!(matches!(reply, Reply::Answered { answer: Answer::Booted { .. } }), "{reply:?}");
        door
    }

    /// Owners answer every command in the snapshot, the deck saves, until the
    /// machine has nothing left of its own.
    async fn owners_until_idle(door: &Door) {
        let mut revision = 0;
        for _ in 0..200 {
            let state = door.machine().state().borrow().value.clone();
            if state.ops.is_empty() {
                return;
            }
            for command in snapshot(&state).commands {
                let outcome = if command.cmd.owner() == Owner::Deck {
                    revision += 1;
                    Outcome::Applied { revision: Some(Revision(revision)) }
                } else {
                    Outcome::Applied { revision: None }
                };
                door.tell(Event::Answered { id: command.id, outcome });
            }
            door.tell(Event::DeckSaved { revision: Revision(revision) });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the machine did not finish: {:#?}", door.machine().state().borrow().value.ops);
    }

    fn close_agent(pane: u64) -> Intent {
        Intent::CloseAgent { workspace: ws(), pane: PaneId(pane), consent: Consent::default() }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_close_is_answered_only_with_its_entry_on_disk_and_the_entry_goes_when_it_is_done() {
        let dir = tempfile::tempdir().unwrap();
        let door = booted(dir.path(), Arc::new(FakeDoors::default())).await;
        let reply = door.ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
        let Reply::Answered { answer: Answer::Accepted { op, .. } } = reply else { panic!("{reply:?}") };
        let file = dir.path().join(format!("{op}.json"));
        assert!(file.exists(), "accepted means on disk");
        owners_until_idle(&door).await;
        assert!(!file.exists(), "removed once every step is done");
        let state = door.machine().state().borrow().value.clone();
        assert!(!state.world.panes.contains_key(&PaneId(2)));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_journal_the_disk_refuses_answers_journal_unavailable_and_lets_the_pane_go() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let door = booted(dir.path(), Arc::new(FakeDoors::default())).await;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let reply = door.ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(reply, Reply::Answered { answer: Answer::refused(Refusal::JournalUnavailable) });
        let again = door.ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
        assert!(matches!(again, Reply::Answered { answer: Answer::Accepted { .. } }), "the capture was let go: {again:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_door_that_panics_is_an_outcome_and_the_step_stays_owed() {
        let dir = tempfile::tempdir().unwrap();
        let door = booted(dir.path(), Arc::new(FakeDoors { panic_on_clean: true, ..FakeDoors::default() })).await;
        // The reconciliation's own cleanup panics: it is said, and done with.
        let consent = Consent { stops: vec![PaneId(1), PaneId(2)], ..Consent::default() };
        let reply = door.ask(|ask| Event::Intent { ask, intent: Intent::CloseWorkspace { workspace: ws(), consent } }).await;
        assert!(matches!(reply, Reply::Answered { answer: Answer::Accepted { .. } }));
        for _ in 0..200 {
            let state = door.machine().state().borrow().value.clone();
            if state.ops.values().any(|op| op.owed) {
                let on_disk = std::fs::read_dir(dir.path()).unwrap().filter_map(|entry| entry.ok()).any(|entry| entry.file_name().to_string_lossy().starts_with("op-"));
                assert!(on_disk, "a debt keeps its entry");
                return;
            }
            for command in snapshot(&state).commands {
                let outcome = match command.cmd {
                    Cmd::RemoveWorkspace { .. } => Outcome::Applied { revision: Some(Revision(1)) },
                    _ => Outcome::Applied { revision: None },
                };
                door.tell(Event::Answered { id: command.id, outcome });
            }
            door.tell(Event::DeckSaved { revision: Revision(1) });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no debt: {:#?}", door.machine().state().borrow().value.ops);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_restart_reads_the_journal_and_finishes_what_it_left() {
        let dir = tempfile::tempdir().unwrap();
        {
            let door = booted(dir.path(), Arc::new(FakeDoors::default())).await;
            let reply = door.ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
            assert!(matches!(reply, Reply::Answered { answer: Answer::Accepted { .. } }));
            // The app dies here, and its machine with it — and, as with a
            // process that has exited, nothing of it writes any more.
            let mut states = door.machine().state();
            drop(door);
            while states.changed().await.is_ok() {}
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let door = booted(dir.path(), Arc::new(FakeDoors::default())).await;
        let state = door.machine().state().borrow().value.clone();
        assert!(state.forgotten.panes.contains(&PaneId(2)), "forgotten from the journal before any door opens");
        owners_until_idle(&door).await;
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "every entry done and removed");
    }

    /// A probe that cannot look does not hand the place out on a guess: it
    /// says the place is taken, and a place typed by hand is refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_probe_that_cannot_look_says_the_place_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        let door = booted(dir.path(), Arc::new(FakeDoors { panic_on_probe: true, ..FakeDoors::default() })).await;
        let site = Site::New { place: Some(Place { path: Dir::new("/wt/mine"), branch: "mine".into() }), base: None };
        let intent = Intent::CreateTeam { workspace: ws(), team: TeamId("team-n".into()), site, draft: Draft::default(), members: vec![] };
        // A place taken as free would wait on its creation, which no owner
        // here carries out: the refusal is the prompt answer.
        let reply = tokio::time::timeout(Duration::from_secs(5), door.ask(|ask| Event::Intent { ask, intent })).await;
        assert_eq!(reply.ok(), Some(Reply::Answered { answer: Answer::refused(Refusal::LocationHeld) }));
    }

    /// A journal that cannot be read is an error, never an empty journal:
    /// nothing may start as if the operations it holds were done.
    #[test]
    fn a_journal_that_cannot_be_read_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_journal(&dir.path().join("not-there"), LOCK_FILE).is_err(), "not to be read");
    }

    /// A file the journal cannot replay is removed by the one read, and the
    /// entries beside it are kept: what the read dropped goes to `start`, to
    /// be logged.
    #[test]
    fn the_read_drops_what_it_cannot_replay_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("op-3.json"), "not an entry").unwrap();
        let loaded = load_journal(dir.path(), LOCK_FILE).expect("the journal");
        assert_eq!(loaded.dropped.iter().map(|dropped| dropped.name.as_str()).collect::<Vec<_>>(), ["op-3.json"]);
        assert!(loaded.entries.is_empty());
        assert!(!dir.path().join("op-3.json").exists(), "removed by the read");
    }
}
