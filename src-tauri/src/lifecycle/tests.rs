//! The machine as the app holds it — behind the journal folder's claim, in
//! managed state, behind the stores' gate — with doors that do what is asked.
//! The machine itself on its runtime, handler, journal and door is the
//! crate's to test.

use super::Lifecycle;
use keepdeck_lifecycle::domain::command::{Outcome, Revision};
use keepdeck_lifecycle::domain::dir::Dir;
use keepdeck_lifecycle::domain::doors::Doors;
use keepdeck_lifecycle::domain::ids::{AttemptId, PaneId, SessionId, TeamId, WorkspaceId};
use keepdeck_lifecycle::domain::journal::Ticket;
use keepdeck_lifecycle::domain::machine::snapshot::snapshot;
use keepdeck_lifecycle::domain::machine::{Clean, Event, Load};
use keepdeck_lifecycle::domain::model::{Answer, Consent, Intent, Refusal, Reply};
use keepdeck_lifecycle::domain::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct FakeDoors;

impl Doors for FakeDoors {
    fn probe(&self, _repo: &Dir, _path: &Dir, _branch: &str) -> bool {
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
    fn clean(&self, _how: &Clean) -> Result<(), String> {
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

async fn booted(root: &std::path::Path, doors: Arc<FakeDoors>) -> Lifecycle {
    let lifecycle = Lifecycle::start_at(root.to_path_buf(), doors);
    let reply = lifecycle.door().ask(|ask| Event::Handshake { ask, deck: deck(), load: Load::Loaded }).await;
    assert!(matches!(reply, Reply::Answered { answer: Answer::Booted { .. } }), "{reply:?}");
    lifecycle
}

/// Owners answer every command in the snapshot, the deck saves, until the
/// machine has nothing left of its own.
async fn owners_until_idle(lifecycle: &Lifecycle) {
    let door = lifecycle.door();
    let mut revision = 0;
    for _ in 0..200 {
        let state = door.machine().state().borrow().value.clone();
        if state.ops.is_empty() {
            return;
        }
        for command in snapshot(&state).commands {
            let outcome = if command.cmd.owner() == keepdeck_lifecycle::domain::command::Owner::Deck {
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

/// The machine's door is had without fail: a lock another thread poisoned
/// still holds a whole door. The sessions' watcher asks for one as its own
/// panic unwinds, where a second panic would abort the app.
#[tokio::test(flavor = "multi_thread")]
async fn the_door_is_had_even_from_a_poisoned_lock() {
    let dir = tempfile::tempdir().unwrap();
    let lifecycle = booted(dir.path(), Arc::new(FakeDoors)).await;
    let poisoner = lifecycle.clone();
    let _ = std::thread::spawn(move || {
        let _held = poisoner.live.lock().unwrap();
        panic!("a panic while the lock is held");
    })
    .join();
    assert!(lifecycle.live.is_poisoned());
    assert!(lifecycle.door().machine().state().has_changed().is_ok(), "the door of the running machine");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stores_gate_refuses_a_closed_panes_writes_and_no_one_elses() {
    use crate::forgotten::{Gate, Source};
    let dir = tempfile::tempdir().unwrap();
    let lifecycle = Arc::new(booted(dir.path(), Arc::new(FakeDoors)).await);
    let asked = lifecycle.clone();
    let gate = Gate::new(super::MachineForgetting::new(move || asked.door()));
    let from = |pane: &str| Source { workspace: "ws-a".into(), team: Some("team-r".into()), pane: Some(pane.into()) };
    assert!(gate.admit(&from("pane-2")).is_ok(), "nothing is forgotten yet");

    let reply = lifecycle.door().ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
    assert!(matches!(reply, Reply::Answered { answer: Answer::Accepted { .. } }));
    owners_until_idle(&lifecycle).await;
    assert!(gate.admit(&from("pane-2")).is_err(), "the closed pane");
    assert!(gate.admit(&from("pane-1")).is_ok(), "its teammate");
    assert!(gate.admit(&Source::from("ws-a")).is_ok(), "its workspace");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_copy_without_the_claim_only_shows() {
    let dir = tempfile::tempdir().unwrap();
    let _first = booted(dir.path(), Arc::new(FakeDoors)).await;
    let second = Lifecycle::start_at(dir.path().to_path_buf(), Arc::new(FakeDoors));
    assert!(!second.claimed());
    let reply = second.door().ask(|ask| Event::Handshake { ask, deck: deck(), load: Load::Loaded }).await;
    assert_eq!(reply, Reply::Answered { answer: Answer::refused(Refusal::BarrierUp) });
    let intent = second.door().ask(|ask| Event::Intent { ask, intent: close_agent(1) }).await;
    assert_eq!(intent, Reply::Answered { answer: Answer::refused(Refusal::BarrierUp) });
}

/// The page hears each state as a snapshot. When the machine's stream ends,
/// it hears that the machine stopped — unless another machine runs in its
/// place, which says so itself.
#[tokio::test(flavor = "multi_thread")]
async fn the_page_hears_its_machine_stop_and_not_a_machine_that_was_replaced() {
    use keepdeck_fsm_runtime::At;
    use keepdeck_lifecycle::domain::machine::snapshot::Heard;
    use keepdeck_lifecycle::domain::machine::State;
    let heard_until_the_end = |running_now: bool| async move {
        let (publish, states) = tokio::sync::watch::channel(At { version: 0, value: State::start(Some(Vec::new())) });
        let heard = Arc::new(Mutex::new(Vec::new()));
        let into = heard.clone();
        let send = move |message| {
            into.lock().unwrap().push(message);
            true
        };
        let publishing = tokio::spawn(super::commands::publish(states, send, move || running_now));
        tokio::time::sleep(Duration::from_millis(20)).await;
        publish.send_modify(|at| at.version = 1);
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(publish);
        publishing.await.unwrap();
        Arc::try_unwrap(heard).unwrap().into_inner().unwrap()
    };
    let fell = heard_until_the_end(false).await;
    assert!(matches!(&fell[..], [Heard::Snapshot { versioned: first }, Heard::Snapshot { versioned: second }, Heard::Stopped] if first.version == 0 && second.version == 1), "{fell:?}");
    let replaced = heard_until_the_end(true).await;
    assert!(!replaced.contains(&Heard::Stopped), "{replaced:?}");
}
