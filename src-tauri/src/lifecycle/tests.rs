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
use keepdeck_lifecycle::domain::model::{Answer, Consent, Intent, Reply};
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

/// The home a copy on `home` would own.
fn claimed(home: &std::path::Path) -> crate::single::Owned {
    let crate::single::Copy::This(owned) = crate::single::enter(home) else { panic!("a free home") };
    owned
}

async fn booted(home: &std::path::Path, doors: Arc<FakeDoors>) -> Lifecycle {
    let lifecycle = Lifecycle::start(doors, claimed(home));
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

#[tokio::test(flavor = "multi_thread")]
async fn the_stores_gate_refuses_a_closed_panes_writes_and_no_one_elses() {
    use crate::forgotten::{Gate, Source};
    let dir = tempfile::tempdir().unwrap();
    let lifecycle = booted(dir.path(), Arc::new(FakeDoors)).await;
    let gate = Gate::new(super::MachineForgetting::new(lifecycle.door()));
    let from = |pane: &str| Source { workspace: "ws-a".into(), team: Some("team-r".into()), pane: Some(pane.into()) };
    assert!(gate.admit(&from("pane-2")).is_ok(), "nothing is forgotten yet");

    let reply = lifecycle.door().ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
    assert!(matches!(reply, Reply::Answered { answer: Answer::Accepted { .. } }));
    owners_until_idle(&lifecycle).await;
    assert!(gate.admit(&from("pane-2")).is_err(), "the closed pane");
    assert!(gate.admit(&from("pane-1")).is_ok(), "its teammate");
    assert!(gate.admit(&Source::from("ws-a")).is_ok(), "its workspace");
}

/// A second copy on a home the first one's machine runs on gets no machine
/// of its own: it is refused at the door, and the lock names the first.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_copy_on_one_home_is_refused_and_names_the_first() {
    use keepdeck_lifecycle::domain::single::{Holder, Way};
    let dir = tempfile::tempdir().unwrap();
    let _first = booted(dir.path(), Arc::new(FakeDoors)).await;
    let first = Some(Holder { pid: std::process::id(), leaving: false });
    assert!(matches!(crate::single::enter(dir.path()), crate::single::Copy::Refused { holder, way: Way::Occupied } if holder == first));
}

/// The page hears each state as a snapshot, and when the machine's stream
/// ends, that the machine stopped.
#[tokio::test(flavor = "multi_thread")]
async fn the_page_hears_its_machine_stop() {
    use keepdeck_fsm_runtime::At;
    use keepdeck_lifecycle::domain::machine::snapshot::Heard;
    use keepdeck_lifecycle::domain::machine::State;
    let (publish, states) = tokio::sync::watch::channel(At { version: 0, value: State::start(Vec::new()) });
    let heard = Arc::new(Mutex::new(Vec::new()));
    let into = heard.clone();
    let send = move |message| {
        into.lock().unwrap().push(message);
        true
    };
    let publishing = tokio::spawn(super::commands::publish(states, send));
    tokio::time::sleep(Duration::from_millis(20)).await;
    publish.send_modify(|at| at.version = 1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    drop(publish);
    publishing.await.unwrap();
    let fell = Arc::try_unwrap(heard).unwrap().into_inner().unwrap();
    assert!(matches!(&fell[..], [Heard::Snapshot { versioned: first }, Heard::Snapshot { versioned: second }, Heard::Stopped] if first.version == 0 && second.version == 1), "{fell:?}");
}
