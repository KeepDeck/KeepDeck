//! The sessions machine, running: one for the app, started at setup. Its rules
//! are `keepdeck_pty::sessions`; this module is its handler, the session table
//! that owns the processes, the spawn door with the start boundary, and the
//! subscription that tells the lifecycle machine about sessions appearing
//! and ending.

mod boundary;
mod table;
#[cfg(test)]
mod tests;

pub use boundary::{Boundary, NotStarted};
pub use table::Table;

use crate::session::{deliver, resolve_command, DeliveryEnd, SessionEvent, SpawnSpec};
use keepdeck_fsm_runtime::{supervised, Effects, Events, Runtime};
use keepdeck_lifecycle::domain::dir::Dir;
use keepdeck_lifecycle::domain::ids::{AttemptId, PermitId, SessionId};
use keepdeck_lifecycle::domain::machine::{Event as LifecycleEvent, LaunchOwner};
use keepdeck_lifecycle::domain::model::{Answer, Refusal, Reply};
use keepdeck_pty::sessions::{self, Effect, Event, Over, Sessions};
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
        // The one line that settles "which build / which args did this pane
        // get" when a session-identity repro comes in. Env values stay
        // private — the key names are what debugging needs.
        log::info!(
            "spawn: cmd={command} args={:?} env={:?} cwd={:?}",
            spec.args,
            spec.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            spec.cwd,
        );
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
        self.machine.send(Event::Registered { id: id.0, tag: Tag { owner, dir, attempt }, secrets: Vec::new() });
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
