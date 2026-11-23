//! The sessions machine with real processes, a real lifecycle machine and its
//! admission: a launch needs a permit, the start boundary holds, a stop by id
//! answers once the session is over, and the lifecycle machine hears of each
//! session appearing and ending.

use super::{OpenError, SessionMachine, Stopped};
use crate::lifecycle::{AppDoors, Lifecycle};
use keepdeck_lifecycle::infrastructure::door::Door;
use crate::session::SpawnSpec;
use keepdeck_lifecycle::domain::dir::Dir;
use keepdeck_lifecycle::domain::ids::{PaneId, PermitId, SessionId, TeamId, WorkspaceId};
use keepdeck_lifecycle::domain::machine::{Event, LaunchOwner, LeaseAsk, Load};
use keepdeck_lifecycle::domain::model::{Answer, Refusal, Reply};
use keepdeck_lifecycle::domain::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};
use std::sync::Arc;
use std::time::Duration;

fn ws() -> WorkspaceId {
    WorkspaceId("ws-a".into())
}

fn deck(cwd: &str) -> DeckFacts {
    DeckFacts {
        workspaces: vec![WorkspaceFacts {
            id: ws(),
            name: "app".into(),
            cwd: Dir::new(cwd),
            worktree_base: None,
            archived: false,
            archiving: false,
            repo: None,
            teams: vec![TeamFacts { id: TeamId("team-r".into()), at: TeamAtFacts::Attached { cwd: Dir::new(cwd), branch: None } }],
            panes: vec![
                PaneFacts { id: PaneId(1), team: Some(TeamId("team-r".into())), remote: false, suspended: false },
                PaneFacts { id: PaneId(2), team: Some(TeamId("team-r".into())), remote: false, suspended: false },
            ],
        }],
    }
}

/// The stores' doors, unasked here: no test of this module cleans.
struct NoStores;

impl crate::lifecycle::StoreDoors for NoStores {
    fn disarm(&self, _dir: &Dir) -> Result<(), String> {
        unreachable!("no cleanup in these tests")
    }
    fn forget(&self, _workspace: &WorkspaceId) -> Result<(), String> {
        unreachable!("no cleanup in these tests")
    }
    fn retain(&self, _workspaces: &[WorkspaceId]) -> Result<(), String> {
        unreachable!("no cleanup in these tests")
    }
    fn discard(&self, _plugin: &str, _paths: &[String]) -> Result<(), String> {
        unreachable!("no cleanup in these tests")
    }
}

struct Rig {
    sessions: SessionMachine,
    lifecycle: Lifecycle,
    cwd: String,
    _journal: tempfile::TempDir,
    _work: tempfile::TempDir,
}

async fn rig() -> Rig {
    let journal = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let cwd = work.path().to_string_lossy().into_owned();
    let sessions = SessionMachine::start();
    let doors = AppDoors::new(sessions.clone(), crate::worktree::RepoLocks::default(), Arc::new(NoStores));
    let lifecycle = Lifecycle::start_at(journal.path().to_path_buf(), Arc::new(doors));
    sessions.link(lifecycle.clone());
    let reply = lifecycle.door().ask(|ask| Event::Handshake { ask, deck: deck(&cwd), load: Load::Loaded }).await;
    assert!(matches!(reply, Reply::Answered { answer: Answer::Booted { .. } }), "{reply:?}");
    Rig { sessions, lifecycle, cwd, _journal: journal, _work: work }
}

impl Rig {
    fn door(&self) -> Door {
        self.lifecycle.door()
    }

    async fn permit(&self, pane: u64) -> PermitId {
        let lease = LeaseAsk::Launch { workspace: ws(), owner: LaunchOwner::Pane { pane: PaneId(pane) }, dir: Some(Dir::new(&self.cwd)) };
        match self.door().ask(|ask| Event::Lease { ask, lease }).await {
            Reply::Answered { answer: Answer::Leased { permit } } => permit,
            other => panic!("no permit: {other:?}"),
        }
    }

    fn spec(&self, script: &str) -> SpawnSpec {
        SpawnSpec {
            command: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
            env_defaults: Vec::new(),
            cwd: Some(self.cwd.clone()),
            cols: 80,
            rows: 24,
        }
    }

    async fn open(&self, permit: PermitId, pane: u64, script: &str) -> Result<SessionId, OpenError> {
        self.sessions.open(&self.door(), permit, LaunchOwner::Pane { pane: PaneId(pane) }, self.spec(script), |_| true).await
    }

    /// Open a session and wait until it has printed `READY` — the point past
    /// which a trap it set is in place.
    async fn open_ready(&self, permit: PermitId, pane: u64, script: &str) -> SessionId {
        use base64::Engine as _;
        let (tell, heard) = std::sync::mpsc::channel::<String>();
        let on_event = move |event| {
            if let crate::session::SessionEvent::Output { data } = event {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
                let _ = tell.send(String::from_utf8_lossy(&bytes).into_owned());
            }
            true
        };
        let owner = LaunchOwner::Pane { pane: PaneId(pane) };
        let session = self.sessions.open(&self.door(), permit, owner, self.spec(script), on_event).await.expect("started");
        let mut seen = String::new();
        while !seen.contains("READY") {
            seen.push_str(&heard.recv_timeout(Duration::from_secs(5)).expect("READY"));
        }
        session
    }

    /// The lifecycle machine's word on a session: seen, and whether over.
    async fn seen(&self, session: SessionId, ended: bool) {
        for _ in 0..200 {
            let state = self.door().machine().state().borrow().value.clone();
            if state.sessions.get(&session).is_some_and(|row| row.ended == ended) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the lifecycle machine never saw {session:?} with ended={ended}");
    }
}

/// However the sessions' watcher ends, the lifecycle machine hears that the
/// sessions are gone, rather than go on admitting launches it would never
/// hear of. Here the sessions machine it watches ends under it.
#[tokio::test(flavor = "multi_thread")]
async fn a_watcher_that_ends_tells_the_lifecycle_the_sessions_are_gone() {
    let journal = tempfile::tempdir().unwrap();
    // The lifecycle's doors stop another machine's sessions: the watched one
    // can end alone.
    let doors = AppDoors::new(SessionMachine::start(), crate::worktree::RepoLocks::default(), Arc::new(NoStores));
    let lifecycle = Lifecycle::start_at(journal.path().to_path_buf(), Arc::new(doors));
    let watched = SessionMachine::start();
    watched.link(lifecycle.clone());
    drop(watched);
    for _ in 0..200 {
        if lifecycle.door().machine().state().borrow().value.sessions_down {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the lifecycle machine never heard that the sessions are gone");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_launch_with_its_permit_runs_and_its_stop_answers_once_it_is_over() {
    let rig = rig().await;
    let permit = rig.permit(1).await;
    let session = rig.open(permit, 1, "sleep 30").await.expect("started");
    rig.seen(session, false).await;
    assert_eq!(rig.sessions.stop_and_wait(session).await, Stopped::Exited);
    rig.seen(session, true).await;
    assert!(rig.sessions.write(session, b"x").is_err(), "no input after the end");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_process_deaf_to_term_is_forced_after_the_grace() {
    let rig = rig().await;
    let permit = rig.permit(1).await;
    let session = rig.open_ready(permit, 1, "trap '' TERM; echo READY; sleep 30").await;
    assert_eq!(rig.sessions.stop_and_wait(session).await, Stopped::Forced);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn no_permit_no_process_and_one_permit_one_process() {
    let rig = rig().await;
    assert_eq!(rig.open(PermitId(999), 1, "sleep 30").await, Err(OpenError::Refused(Refusal::NotFound)), "forged");
    let permit = rig.permit(1).await;
    let first = rig.open(permit, 1, "sleep 30").await;
    let second = rig.open(permit, 1, "sleep 30").await;
    assert!(first.is_ok());
    assert_eq!(second, Err(OpenError::Refused(Refusal::NotFound)), "spent");
    assert_eq!(rig.sessions.stop_and_wait(first.unwrap()).await, Stopped::Exited);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_launch_cancelled_at_the_boundary_never_starts() {
    let rig = rig().await;
    let permit = rig.permit(2).await;
    // A Close took the attempt over before the door crossed: the attempt the
    // admission will make is the next one; cancel it ahead.
    let attempt = keepdeck_lifecycle::domain::ids::AttemptId(rig.door().machine().state().borrow().value.next.attempt.next().0);
    assert!(rig.sessions.boundary.cancel(&[attempt]).is_empty());
    let opened = rig.open(permit, 2, "sleep 30").await;
    assert_eq!(opened, Err(OpenError::NotStarted(super::NotStarted::Cancelled)));
    let mut states = rig.door().machine().state();
    let heard = tokio::time::timeout(Duration::from_secs(5), states.wait_for(|at| at.value.attempts.is_empty())).await;
    assert!(heard.is_ok(), "the lifecycle machine heard it did not start");
}
