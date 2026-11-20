//! The running machine on its real runtime, journal and waiting door, with
//! fake doors for git, the stores and the sessions machine.

use super::door::{Door, Waiters};
use super::{Doors, Lifecycle};
use keepdeck_fsm::{stay, Next, Owed};
use keepdeck_fsm_runtime::{Effects, Events, Runtime};
use keepdeck_lifecycle::command::{Cmd, Outcome, Revision};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AskId, AttemptId, PaneId, SessionId, TeamId, WorkspaceId};
use keepdeck_lifecycle::journal::Ticket;
use keepdeck_lifecycle::machine::snapshot::snapshot;
use keepdeck_lifecycle::machine::{Clean, Event, Load};
use keepdeck_lifecycle::model::{Answer, Consent, Intent, Refusal, Reply};
use keepdeck_lifecycle::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct FakeDoors {
    cleaned: Mutex<Vec<Clean>>,
    panic_on_clean: bool,
}

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
            let outcome = if command.cmd.owner() == keepdeck_lifecycle::command::Owner::Deck {
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
    let lifecycle = Arc::new(booted(dir.path(), Arc::new(FakeDoors::default())).await);
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
async fn a_close_is_answered_only_with_its_entry_on_disk_and_the_entry_goes_when_it_is_done() {
    let dir = tempfile::tempdir().unwrap();
    let lifecycle = booted(dir.path(), Arc::new(FakeDoors::default())).await;
    let reply = lifecycle.door().ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
    let Reply::Answered { answer: Answer::Accepted { op, .. } } = reply else { panic!("{reply:?}") };
    let file = dir.path().join(format!("{op}.json"));
    assert!(file.exists(), "accepted means on disk");
    owners_until_idle(&lifecycle).await;
    assert!(!file.exists(), "removed once every step is done");
    let state = lifecycle.door().machine().state().borrow().value.clone();
    assert!(!state.world.panes.contains_key(&PaneId(2)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_journal_the_disk_refuses_answers_journal_unavailable_and_lets_the_pane_go() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let lifecycle = booted(dir.path(), Arc::new(FakeDoors::default())).await;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let reply = lifecycle.door().ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(reply, Reply::Answered { answer: Answer::refused(Refusal::JournalUnavailable) });
    let again = lifecycle.door().ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
    assert!(matches!(again, Reply::Answered { answer: Answer::Accepted { .. } }), "the capture was let go: {again:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_door_that_panics_is_an_outcome_and_the_step_stays_owed() {
    let dir = tempfile::tempdir().unwrap();
    let doors = Arc::new(FakeDoors { panic_on_clean: true, ..FakeDoors::default() });
    let lifecycle = booted(dir.path(), doors).await;
    // The reconciliation's own cleanup panics: it is said, and done with.
    let consent = Consent { stops: vec![PaneId(1), PaneId(2)], ..Consent::default() };
    let reply = lifecycle.door().ask(|ask| Event::Intent { ask, intent: Intent::CloseWorkspace { workspace: ws(), consent } }).await;
    assert!(matches!(reply, Reply::Answered { answer: Answer::Accepted { .. } }));
    let door = lifecycle.door();
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
        let lifecycle = booted(dir.path(), Arc::new(FakeDoors::default())).await;
        let reply = lifecycle.door().ask(|ask| Event::Intent { ask, intent: close_agent(2) }).await;
        assert!(matches!(reply, Reply::Answered { answer: Answer::Accepted { .. } }));
        // The app dies here: the claim and the machine go with it — and, as
        // with a process that has exited, nothing of it writes any more.
        let mut states = lifecycle.door().machine().state();
        drop(lifecycle);
        while states.changed().await.is_ok() {}
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let lifecycle = booted(dir.path(), Arc::new(FakeDoors::default())).await;
    let state = lifecycle.door().machine().state().borrow().value.clone();
    assert!(state.forgotten.panes.contains(&PaneId(2)), "forgotten from the journal before any door opens");
    owners_until_idle(&lifecycle).await;
    assert!(std::fs::read_dir(dir.path()).unwrap().filter_map(|entry| entry.ok()).all(|entry| entry.file_name() == "lock"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_copy_without_the_claim_only_shows() {
    let dir = tempfile::tempdir().unwrap();
    let _first = booted(dir.path(), Arc::new(FakeDoors::default())).await;
    let second = Lifecycle::start_at(dir.path().to_path_buf(), Arc::new(FakeDoors::default()));
    assert!(!second.claimed());
    let reply = second.door().ask(|ask| Event::Handshake { ask, deck: deck(), load: Load::Loaded }).await;
    assert_eq!(reply, Reply::Answered { answer: Answer::refused(Refusal::BarrierUp) });
    let intent = second.door().ask(|ask| Event::Intent { ask, intent: close_agent(1) }).await;
    assert_eq!(intent, Reply::Answered { answer: Answer::refused(Refusal::BarrierUp) });
}

// ---------------------------------------------------------------- the waiting door

/// A machine that answers `Answer` asks, never answers `Silent` ones, and
/// dies on `Die` — on its own task, as a panic in a machine does.
#[derive(Clone, Debug, PartialEq)]
enum Probe {
    Answer(AskId),
    Silent(AskId),
    AnswerThenDie(AskId),
    Die,
}

#[derive(Clone, Debug, PartialEq)]
enum Said {
    Answer(AskId),
    Die,
}

fn probe_update(_: &u8, event: Probe) -> Next<u8, Said> {
    match event {
        Probe::Answer(ask) => stay().run(Said::Answer(ask)),
        Probe::Silent(_) => stay(),
        Probe::AnswerThenDie(ask) => stay().run(Said::Answer(ask)).run(Said::Die),
        Probe::Die => stay().run(Said::Die),
    }
}

fn probe_work(_: &u8) -> Owed<Said, Probe> {
    Owed::nothing()
}

struct ProbeHandler(Waiters);

impl Effects<Said, Probe> for ProbeHandler {
    fn run(&mut self, effect: Said, _: &Events<Probe>) {
        match effect {
            Said::Answer(ask) => self.0.deliver(ask, Answer::Booted { finishing: Vec::new() }),
            Said::Die => panic!("the machine dies"),
        }
    }
}

fn probe_door() -> Door<u8, Probe> {
    let waiters = Waiters::default();
    let machine = Runtime::start(0, probe_update, probe_work, ProbeHandler(waiters.clone()));
    Door::new(machine, waiters)
}

async fn dead(door: &Door<u8, Probe>) {
    let mut states = door.machine().state();
    door.tell(Probe::Die);
    while states.changed().await.is_ok() {}
}

#[tokio::test(flavor = "multi_thread")]
async fn the_door_answers_with_the_machines_answer() {
    let door = probe_door();
    assert_eq!(door.ask(Probe::Answer).await, Reply::Answered { answer: Answer::Booted { finishing: Vec::new() } });
}

#[tokio::test(flavor = "multi_thread")]
async fn a_machine_gone_before_the_ask_is_unavailable() {
    let door = probe_door();
    dead(&door).await;
    assert_eq!(door.ask(Probe::Answer).await, Reply::Unavailable);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_machine_gone_after_the_ask_unanswered_is_unknown() {
    let door = probe_door();
    let asking = { let door = door.clone(); tokio::spawn(async move { door.ask(Probe::Silent).await }) };
    tokio::time::sleep(Duration::from_millis(20)).await;
    door.tell(Probe::Die);
    assert_eq!(asking.await.unwrap(), Reply::Unknown);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_ready_with_the_end_is_still_the_answer() {
    let door = probe_door();
    assert_eq!(door.ask(Probe::AnswerThenDie).await, Reply::Answered { answer: Answer::Booted { finishing: Vec::new() } });
}

/// The page hears each state as a snapshot. When the machine's stream ends,
/// it hears that the machine stopped — unless another machine runs in its
/// place, which says so itself.
#[tokio::test(flavor = "multi_thread")]
async fn the_page_hears_its_machine_stop_and_not_a_machine_that_was_replaced() {
    use keepdeck_fsm_runtime::At;
    use keepdeck_lifecycle::machine::snapshot::Heard;
    use keepdeck_lifecycle::machine::State;
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
