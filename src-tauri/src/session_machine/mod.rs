//! The sessions machine, running: one for the app, started at setup. Its rules
//! are `keepdeck_pty::sessions`; this module is its handler, the session table
//! that owns the processes, the spawn door with the start boundary, and the
//! subscription that tells the lifecycle machine about sessions appearing
//! and ending.

mod boundary;
mod table;
#[cfg(all(test, unix))]
mod test_support;
#[cfg(test)]
mod tests;

pub use boundary::{Boundary, NotStarted};
pub use table::Table;

use crate::session::{deliver, resolve_command, DeliveryEnd, SessionEvent, SpawnSpec};
use keepdeck_fsm_runtime::{supervised, Effects, Events, Runtime};
use keepdeck_lifecycle::domain::dir::Dir;
use keepdeck_lifecycle::domain::ids::{AttemptId, PaneId, PermitId, SessionId};
use keepdeck_lifecycle::domain::machine::{Event as LifecycleEvent, LaunchOwner};
use keepdeck_lifecycle::domain::model::{Answer, Refusal, Reply};
use keepdeck_pty::sessions::{self, CallerRefusal, CallerVerdict, Effect, Event, Over, Secret, Sessions, REGISTRATION_WAIT};
use keepdeck_pty::{Consumer, PtyEvent, PtySession, PtySpec, TermSize};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// Whose session a row is, as the lifecycle machine needs to hear it.
#[derive(Clone, Debug, PartialEq)]
pub struct Tag {
    pub owner: LaunchOwner,
    pub dir: Option<Dir>,
    pub attempt: AttemptId,
}

pub type Machine = Runtime<Sessions<Tag>, Event<Tag>>;

/// The machine and what its handler and doors share.
#[derive(Clone)]
pub struct SessionMachine {
    pub machine: Machine,
    pub table: Arc<Table>,
    pub boundary: Arc<Boundary>,
}

struct Handler {
    table: Arc<Table>,
}

/// The sessions' watcher's hold on the lifecycle machine. However the watcher
/// ends — this machine gone, or a panic in it — letting go of it tells the
/// lifecycle the sessions are gone: a lifecycle that went on unaware would
/// admit launches it never hears of, and wait on their sessions for nothing.
/// The hold is the machine's door itself: asked again while a panic unwinds,
/// a lookup that could fail would abort the app. The app's exit does not
/// drop it: the process ends around it.
struct Watching {
    door: keepdeck_lifecycle::infrastructure::door::Door,
}

impl Drop for Watching {
    fn drop(&mut self) {
        self.door.tell(LifecycleEvent::SessionsGone);
    }
}

impl Effects<Effect, Event<Tag>> for Handler {
    fn run(&mut self, effect: Effect, events: &Events<Event<Tag>>) {
        match effect {
            Effect::Term { id } => {
                if let Some(session) = self.table.get(SessionId(id)) {
                    let _ = session.signal_stop();
                }
            }
            Effect::Kill { id } => {
                let table = self.table.clone();
                events.spawn(async move {
                    // A handle already let go is a process already exited:
                    // its exit is on its way, if it has not come.
                    let sent = supervised(move || {
                        if let Some(session) = table.get(SessionId(id)) {
                            session.force_stop();
                        }
                        Ok(())
                    })
                    .await
                    .is_ok();
                    Some(Event::Killed { id, sent })
                });
            }
        }
    }
}

/// How an exact-session stop ended, for the door that asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stopped {
    Exited,
    Forced,
    Unconfirmed,
    /// No such session, or the sessions machine is gone.
    Unknown,
}

/// Why the spawn door did not start a process.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    Refused(Refusal),
    /// The lifecycle machine could not be asked.
    Unavailable,
    NotStarted(NotStarted),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Refused(refusal) => write!(f, "refused: {refusal:?}"),
            OpenError::Unavailable => write!(f, "the lifecycle machine is not there"),
            OpenError::NotStarted(why) => write!(f, "not started: {why:?}"),
        }
    }
}

impl SessionMachine {
    /// Start the machine. Call where a tokio runtime is entered.
    pub fn start() -> SessionMachine {
        let table = Arc::new(Table::default());
        let machine = Runtime::start(Sessions::default(), sessions::update, sessions::work, Handler { table: table.clone() });
        SessionMachine { machine, table, boundary: Arc::new(Boundary::default()) }
    }

    fn alive(&self) -> bool {
        self.machine.state().has_changed().is_ok()
    }

    /// Stop this exact session. Safe to ask again.
    pub fn stop(&self, session: SessionId) {
        self.machine.send(Event::Stop { id: session.0 });
    }

    /// Stop this exact session and answer only once it is over — exited,
    /// forced or unconfirmed.
    pub async fn stop_and_wait(&self, session: SessionId) -> Stopped {
        let mut states = self.machine.state();
        if !states.borrow().value.rows.contains_key(&session.0) {
            return Stopped::Unknown;
        }
        self.stop(session);
        let over = states
            .wait_for(|at| at.value.rows.get(&session.0).is_some_and(|row| row.over()))
            .await
            .map(|at| at.value.rows[&session.0].phase);
        match over {
            Ok(sessions::Phase::Over(Over::Exited)) => Stopped::Exited,
            Ok(sessions::Phase::Over(Over::Forced)) => Stopped::Forced,
            Ok(sessions::Phase::Over(Over::Unconfirmed { .. })) => Stopped::Unconfirmed,
            _ => Stopped::Unknown,
        }
    }

    /// Input goes only to a live session.
    pub fn write(&self, session: SessionId, bytes: &[u8]) -> std::io::Result<()> {
        let live = self.machine.state().borrow().value.rows.get(&session.0).is_some_and(|row| row.live());
        match self.table.get(session).filter(|_| live) {
            Some(handle) => handle.write(bytes),
            None => Err(std::io::Error::other(format!("session {} is not live", session.0))),
        }
    }

    /// The pane a caller speaks for: the one whose live terminal process
    /// `pid` belongs to, when that terminal's session holds `secret`. Asked
    /// per request by whoever lets a caller act for a pane.
    ///
    /// An early caller is waited for, up to [`REGISTRATION_WAIT`] in all,
    /// because one refused that early would stay refused. Its process can
    /// run before the spawn door hands it to the table, so a caller no
    /// terminal places is asked about again once the spawns under way are
    /// over. And the table holds a terminal before the machine hears of it,
    /// so a terminal not registered yet is awaited. After a wait the terminal
    /// is looked up again too, since it may have ended meanwhile. What the
    /// spent wait means is the rule's ([`sessions::after_registration_wait`]).
    pub async fn caller(&self, pid: Option<u32>, secret: Option<&Secret>) -> Result<PaneId, CallerRefusal> {
        let deadline = tokio::time::Instant::now() + REGISTRATION_WAIT;
        let terminal_of = || pid.and_then(|pid| self.table.terminal_of(pid));
        let host = |terminal: Option<(PaneId, SessionId)>| terminal.map(|(_, session)| session.0);
        let mut terminal = terminal_of();
        let mut states = self.machine.state();
        // Each borrow ends with its statement: one held across the wait would
        // stop the machine publishing the very row waited for.
        let mut verdict = sessions::judge_caller(&states.borrow().value, host(terminal), secret);
        let unplaced = matches!(verdict, CallerVerdict::Refuse(CallerRefusal::OutsideTerminal)) && terminal.is_none();
        if unplaced && pid.is_some() && self.table.is_opening() {
            drop(tokio::time::timeout_at(deadline, self.table.opened()).await);
            terminal = terminal_of();
            verdict = sessions::judge_caller(&states.borrow().value, host(terminal), secret);
        }
        if let (CallerVerdict::NotRegistered, Some(id)) = (verdict, host(terminal)) {
            let registered = states.wait_for(|at| at.value.rows.contains_key(&id));
            drop(tokio::time::timeout_at(deadline, registered).await);
            terminal = terminal_of();
            verdict = sessions::judge_caller(&states.borrow().value, host(terminal), secret);
        }
        sessions::after_registration_wait(verdict)?;
        terminal.map(|(pane, _)| pane).ok_or(CallerRefusal::OutsideTerminal)
    }

    pub fn resize(&self, session: SessionId, cols: u16, rows: u16) -> std::io::Result<()> {
        match self.table.get(session) {
            Some(handle) => handle.resize(cols, rows),
            None => Err(std::io::Error::other(format!("no session {}", session.0))),
        }
    }

    /// Tell the lifecycle machine behind `door` about every session appearing
    /// and ending, and about the end of this watcher.
    pub fn link(&self, door: keepdeck_lifecycle::infrastructure::door::Door) {
        let mut states = self.machine.state();
        tauri::async_runtime::spawn(async move {
            let watching = Watching { door };
            let mut seen: HashMap<u64, bool> = HashMap::new();
            loop {
                let rows: Vec<(u64, Tag, bool)> = {
                    let at = states.borrow_and_update();
                    at.value.rows.iter().map(|(&id, row)| (id, row.tag.clone(), row.over())).collect()
                };
                let door = &watching.door;
                for (id, tag, over) in rows {
                    let ended = seen.entry(id).or_insert_with(|| {
                        door.tell(LifecycleEvent::SessionAppeared {
                            session: SessionId(id),
                            attempt: Some(tag.attempt),
                            owner: tag.owner,
                            dir: tag.dir,
                        });
                        false
                    });
                    if over && !*ended {
                        *ended = true;
                        door.tell(LifecycleEvent::SessionEnded { session: SessionId(id) });
                    }
                }
                if states.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    /// The spawn door: admission first, then the start boundary, held across
    /// the OS spawn and the handle's transfer to the table, then the report to
    /// this machine. Output goes to `on_event` until the session ends.
    pub async fn open(
        &self,
        lifecycle: &keepdeck_lifecycle::infrastructure::door::Door,
        permit: PermitId,
        owner: LaunchOwner,
        spec: SpawnSpec,
        mut on_event: impl FnMut(SessionEvent) -> bool + Send + 'static,
    ) -> Result<SessionId, OpenError> {
        let dir = match owner {
            LaunchOwner::Remote { .. } => None,
            _ => spec.cwd.as_deref().map(Dir::new),
        };
        let reply = lifecycle.ask(|ask| LifecycleEvent::Admit { ask, permit, owner: owner.clone(), dir: dir.clone() }).await;
        let attempt = match reply {
            Reply::Answered { answer: Answer::Admitted { attempt } } => attempt,
            Reply::Answered { answer: Answer::Refused { refusal } } => return Err(OpenError::Refused(refusal)),
            Reply::Answered { .. } | Reply::Unavailable | Reply::Unknown => return Err(OpenError::Unavailable),
        };
        let command = resolve_command(spec.command, std::env::var("SHELL").ok());
        let secrets: Vec<Secret> = spec.secrets.into_iter().filter(|secret| !secret.is_empty()).map(Secret::new).collect();
        log::info!("{}", spawn_line(&command, &spec.args, &spec.env, spec.cwd.as_deref(), &secrets));
        let pty = PtySpec {
            command,
            args: spec.args,
            env: spec.env,
            env_defaults: spec.env_defaults,
            cwd: spec.cwd.map(PathBuf::from),
            size: TermSize { cols: spec.cols, rows: spec.rows },
        };
        let this = self.clone();
        let pane = owner.pane();
        let crossed = supervised(move || {
            let mut consumer: Option<Consumer> = None;
            let crossed = this.boundary.cross(attempt, || {
                // From the OS spawn until the handle is in the table, the
                // process may run where no terminal places it: an early
                // caller waits for this to end.
                let _opening = this.table.opening();
                let (session, events) = PtySession::spawn(pty).map_err(|e| e.to_string())?;
                // No machine to own the session, or the app going: the door
                // stops what it started itself.
                if !this.alive() {
                    session.force_stop();
                    return Err("the sessions machine is gone".into());
                }
                let id = this.table.insert(session, pane).map_err(|refused| {
                    refused.force_stop();
                    "the app is exiting".to_string()
                })?;
                consumer = Some(events);
                Ok(id)
            });
            Ok((crossed, consumer))
        })
        .await;
        let (id, events) = match crossed {
            Ok((Ok(id), Some(events))) => (id, events),
            Ok((Err(why), _)) => {
                lifecycle.tell(LifecycleEvent::NotStarted { attempt });
                return Err(OpenError::NotStarted(why));
            }
            Ok((Ok(_), None)) | Err(_) => {
                lifecycle.tell(LifecycleEvent::NotStarted { attempt });
                return Err(OpenError::NotStarted(NotStarted::Failed("the spawn did not finish".into())));
            }
        };
        self.machine.send(Event::Registered { id: id.0, tag: Tag { owner, dir, attempt }, secrets });
        let this = self.clone();
        std::thread::spawn(move || {
            let name = format!("session {}", id.0);
            if deliver(&events, &name, &mut on_event) == DeliveryEnd::ChannelGone {
                // Nobody listens: the session is stopped by its one rule,
                // and its exit is still awaited here.
                this.stop(id);
                while !matches!(events.recv(), Some(PtyEvent::Exited(_)) | None) {}
            }
            this.table.remove(id);
            this.machine.send(Event::Exited { id: id.0 });
        });
        Ok(id)
    }
}

/// The one line that settles "which build / which args did this pane get"
/// when a session-identity repro comes in. Env values stay private, the key
/// names are what debugging needs. The pane's secrets are hidden by value
/// wherever they stand: agents carry them inside arguments, as claude does in
/// its `--mcp-config` JSON and codex in `-c mcp_servers…`, and nothing keeps
/// one out of a command or a folder. So each argument is hidden as it is,
/// before quoting could change how a secret reads, and then the whole line.
fn spawn_line(command: &str, args: &[String], env: &[(String, String)], cwd: Option<&str>, secrets: &[Secret]) -> String {
    let hide = |text: &str| secrets.iter().fold(text.to_string(), |text, secret| text.replace(secret.expose(), "<secret>"));
    let args: Vec<String> = args.iter().map(|arg| hide(arg)).collect();
    let keys: Vec<&str> = env.iter().map(|(key, _)| key.as_str()).collect();
    hide(&format!("spawn: cmd={command} args={args:?} env={keys:?} cwd={cwd:?}"))
}

#[tauri::command]
pub async fn pty_open(
    sessions: tauri::State<'_, SessionMachine>,
    lifecycle: tauri::State<'_, crate::lifecycle::Lifecycle>,
    spec: SpawnSpec,
    permit: PermitId,
    owner: LaunchOwner,
    on_event: tauri::ipc::Channel<SessionEvent>,
) -> Result<SessionId, String> {
    let door = lifecycle.door();
    sessions.open(&door, permit, owner, spec, move |event| on_event.send(event).is_ok()).await.map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_write(sessions: tauri::State<'_, SessionMachine>, id: SessionId, data: Vec<u8>) -> Result<(), String> {
    sessions.write(id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(sessions: tauri::State<'_, SessionMachine>, id: SessionId, cols: u16, rows: u16) -> Result<(), String> {
    sessions.resize(id, cols, rows).map_err(|e| e.to_string())
}

/// Stop this exact session; answers once it is over.
#[tauri::command]
pub async fn pty_stop(sessions: tauri::State<'_, SessionMachine>, id: SessionId) -> Result<Stopped, String> {
    Ok(sessions.stop_and_wait(id).await)
}
