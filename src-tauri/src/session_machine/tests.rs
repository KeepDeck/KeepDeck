//! The sessions machine with real processes, a real lifecycle machine and its
//! admission: a launch needs a permit, the start boundary holds, a stop by id
//! answers once the session is over, and the lifecycle machine hears of each
//! session appearing and ending.

use super::{OpenError, SessionMachine, Stopped, Tag};
#[cfg(unix)]
use super::test_support::{first_pid, pid_after, sleeper};
use keepdeck_pty::sessions::{CallerRefusal, Event as SessionsEvent, Secret, CALLER_WAIT};
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

/// The home a copy on `home` would own.
fn claimed(home: &std::path::Path) -> crate::single::Owned {
    let crate::single::Admission::This(owned) = crate::single::enter(home) else { panic!("a free home") };
    owned
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
    let lifecycle = Lifecycle::start(Arc::new(doors), claimed(journal.path()));
    sessions.link(lifecycle.door());
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
            secrets: Vec::new(),
        }
    }

    /// Open pane `pane`'s process with `secrets`, and wait for the pid of its
    /// leader.
    async fn open_with_secrets(&self, permit: PermitId, pane: u64, secrets: &[&str]) -> (SessionId, u32) {
        use base64::Engine as _;
        let (tell, heard) = std::sync::mpsc::channel::<String>();
        let on_event = move |event| {
            if let crate::session::SessionEvent::Output { data } = event {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
                let _ = tell.send(String::from_utf8_lossy(&bytes).into_owned());
            }
            true
        };
        let mut spec = self.spec("echo PID=$$; sleep 30");
        spec.secrets = secrets.iter().map(|secret| secret.to_string()).collect();
        let owner = LaunchOwner::Pane { pane: PaneId(pane) };
        let session = self.sessions.open(&self.door(), permit, owner, spec, on_event).await.expect("started");
        let mut seen = String::new();
        loop {
            if let Some(pid) = pid_after(&seen, "PID") {
                return (session, pid);
            }
            seen.push_str(&heard.recv_timeout(Duration::from_secs(5)).expect("PID"));
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
    let lifecycle = Lifecycle::start(Arc::new(doors), claimed(journal.path()));
    let watched = SessionMachine::start();
    watched.link(lifecycle.door());
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

/// A caller from a pane's live terminal speaks for it by either of the
/// secrets its plan handed `pty_open`, and for nobody otherwise: another
/// secret, none, a process in no pane's terminal, or once the pane is gone.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_caller_speaks_for_the_pane_whose_live_terminal_holds_its_secret() {
    let rig = rig().await;
    let permit = rig.permit(1).await;
    let (session, pid) = rig.open_with_secrets(permit, 1, &["s-mcp", "s-bridge"]).await;
    let caller = |pid: Option<u32>, secret: Option<&'static str>| {
        let sessions = rig.sessions.clone();
        async move { sessions.caller(pid, secret.map(Secret::new).as_ref()).await }
    };

    for secret in ["s-mcp", "s-bridge"] {
        assert_eq!(caller(Some(pid), Some(secret)).await, Ok(PaneId(1)), "{secret}");
    }
    assert_eq!(caller(Some(pid), Some("another")).await, Err(CallerRefusal::WrongSecret));
    assert_eq!(caller(Some(pid), None).await, Err(CallerRefusal::NoSecret));
    assert_eq!(caller(Some(std::process::id()), Some("s-mcp")).await, Err(CallerRefusal::OutsideTerminal), "this test runs in no pane");
    assert_eq!(caller(None, Some("s-mcp")).await, Err(CallerRefusal::OutsideTerminal), "a peer the kernel could not name");

    assert_eq!(rig.sessions.stop_and_wait(session).await, Stopped::Exited);
    assert_eq!(caller(Some(pid), Some("s-mcp")).await, Err(CallerRefusal::OutsideTerminal), "a closed pane's secret");
}

/// What the machine's own row says of a pane whose terminal is in the table:
/// the session the spawn door would register.
#[cfg(unix)]
fn tag(pane: u64) -> Tag {
    Tag {
        owner: LaunchOwner::Pane { pane: PaneId(pane) },
        dir: None,
        attempt: keepdeck_lifecycle::domain::ids::AttemptId(1),
    }
}

/// The spawn door puts a process in the table before the machine hears of
/// it. A caller that early is waited for and admitted once the row lands. On
/// the real machine runtime, so a borrow of its state held across the wait
/// would stop the very row arriving: this test then hangs (checked).
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_caller_early_in_its_terminal_is_admitted_once_the_session_is_registered() {
    let sessions = SessionMachine::start();
    let (terminal, events) = sleeper("echo PID=$$; sleep 30");
    let pid = first_pid(&events);
    let id = sessions.table.insert(terminal, Some(PaneId(1))).ok().unwrap();
    let late = sessions.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        late.machine.send(SessionsEvent::Registered { id: id.0, tag: tag(1), secrets: vec![Secret::new("s")] });
    });

    assert_eq!(sessions.caller(Some(pid), Some(&Secret::new("s"))).await, Ok(PaneId(1)));
    sessions.table.shutdown(Duration::from_millis(200));
}

/// A terminal the machine never registers is refused once the wait is spent,
/// and not before.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_terminal_never_registered_is_refused_once_the_wait_is_spent() {
    let sessions = SessionMachine::start();
    let (terminal, events) = sleeper("echo PID=$$; sleep 30");
    let pid = first_pid(&events);
    sessions.table.insert(terminal, Some(PaneId(1))).ok().unwrap();

    let asked = tokio::time::Instant::now();
    assert_eq!(sessions.caller(Some(pid), Some(&Secret::new("s"))).await, Err(CallerRefusal::NeverRegistered));
    assert!(asked.elapsed() >= CALLER_WAIT, "refused after {:?}", asked.elapsed());
    // No secret is refused at once, unregistered terminal or not.
    let asked = tokio::time::Instant::now();
    assert_eq!(sessions.caller(Some(pid), None).await, Err(CallerRefusal::NoSecret));
    assert_eq!(asked.elapsed(), Duration::ZERO);
    sessions.table.shutdown(Duration::from_millis(200));
}

/// A process runs from the OS spawn on, before the spawn door hands it to the
/// table. A caller that early is asked about again once the spawn is over,
/// and admitted once its row lands.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_caller_whose_terminal_is_not_in_the_table_yet_is_admitted_once_it_is() {
    let sessions = SessionMachine::start();
    let (terminal, events) = sleeper("echo PID=$$; sleep 30");
    let pid = first_pid(&events);
    let (begun, spawning) = tokio::sync::oneshot::channel();
    let door = sessions.clone();
    tokio::spawn(async move {
        let opening = door.table.opening();
        begun.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let id = door.table.insert(terminal, Some(PaneId(1))).ok().unwrap();
        drop(opening);
        door.machine.send(SessionsEvent::Registered { id: id.0, tag: tag(1), secrets: vec![Secret::new("s")] });
    });
    spawning.await.unwrap();

    assert_eq!(sessions.caller(Some(pid), Some(&Secret::new("s"))).await, Ok(PaneId(1)));
    sessions.table.shutdown(Duration::from_millis(200));
}

/// A terminal that ends while its row is awaited is not judged by what the
/// table said before the wait: the row lands live, the terminal is gone, and
/// the caller is refused.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_terminal_that_ends_while_its_row_is_awaited_is_refused() {
    let sessions = SessionMachine::start();
    let (terminal, events) = sleeper("echo PID=$$; sleep 30");
    let pid = first_pid(&events);
    let id = sessions.table.insert(terminal, Some(PaneId(1))).ok().unwrap();
    let handle = sessions.table.get(id).unwrap();
    let late = sessions.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The exit is seen by the table first; the machine hears of the
        // registration before it hears of the exit.
        late.table.remove(id);
        late.machine.send(SessionsEvent::Registered { id: id.0, tag: tag(1), secrets: vec![Secret::new("s")] });
    });

    assert_eq!(sessions.caller(Some(pid), Some(&Secret::new("s"))).await, Err(CallerRefusal::OutsideTerminal));
    handle.force_stop();
}

/// The spawn line hides a pane's secrets wherever they stand, inside a JSON
/// argument too, and prints no environment value.
#[test]
fn the_spawn_line_carries_no_secret_and_no_env_value() {
    let secrets = [Secret::new("5f3c-mcp"), Secret::new("9a1e-bridge")];
    let line = super::spawn_line(
        "claude",
        &[
            "--mcp-config".into(),
            r#"{"mcpServers":{"keepdeck":{"command":"/kd","args":["--mcp-shim","/s","--client","5f3c-mcp"]}}}"#.into(),
        ],
        &[("KEEPDECK_BRIDGE".into(), r#"{"token":"9a1e-bridge"}"#.into())],
        Some("/repo"),
        &secrets,
    );
    for secret in &secrets {
        assert!(!line.contains(secret.expose()), "{line}");
    }
    assert!(line.contains("KEEPDECK_BRIDGE") && line.contains("<secret>") && line.contains("--mcp-config"), "{line}");

    // Outside the arguments as well: in the command, and in the folder.
    let line = super::spawn_line("/bin/5f3c-mcp", &[], &[], Some("/tmp/9a1e-bridge/repo"), &secrets);
    for secret in &secrets {
        assert!(!line.contains(secret.expose()), "{line}");
    }
    assert!(line.contains("cmd=/bin/<secret>") && line.contains("/tmp/<secret>/repo"), "{line}");
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
