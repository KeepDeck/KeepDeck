//! Session delivery layer: bridges the `keepdeck-pty` process layer to the
//! webview over Tauri IPC.
//!
//! Clean-architecture boundary — this adapter depends on the `keepdeck-pty`
//! domain crate, never the reverse. It owns a [`SessionRegistry`] of live
//! sessions (Tauri managed state), exposes the `session_*` commands the UI
//! calls, and forwards each session's [`PtyEvent`]s to a per-session
//! [`Channel`].

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use keepdeck_pty::{PtyEvent, PtySession, PtySpec, TermSize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Request DTO for [`session_spawn`]. `command` defaults to the user's shell.
/// camelCase like every multi-word wire DTO: Tauri's own case conversion
/// covers command PARAMETER names only — struct FIELDS are raw serde, and a
/// missing rename here once made `envDefaults` silently deserialize to an
/// empty default (opencode skills died without a single error).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub env_defaults: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Event DTO streamed to the webview over the per-session channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    /// Raw output bytes from the PTY.
    Output { bytes: Vec<u8> },
    /// The session's child process exited.
    Exit { success: bool, code: Option<u32> },
}

impl From<PtyEvent> for SessionEvent {
    fn from(event: PtyEvent) -> Self {
        match event {
            PtyEvent::Output(bytes) => SessionEvent::Output { bytes },
            PtyEvent::Exited(info) => SessionEvent::Exit {
                success: info.success,
                code: info.code,
            },
        }
    }
}

/// Registry of live sessions keyed by a minted string id. Tauri managed state.
#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<PtySession>>,
    next: u64,
}

impl SessionRegistry {
    /// Store a session under a fresh monotonic id and return the id.
    fn insert(&self, session: PtySession) -> String {
        let mut reg = self.inner.lock().expect("session registry poisoned");
        reg.next += 1;
        let id = format!("s{}", reg.next);
        reg.sessions.insert(id.clone(), Arc::new(session));
        id
    }

    fn remove(&self, id: &str) {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .sessions
            .remove(id);
    }

    /// Look up a session handle. The registry lock is held only for the lookup,
    /// never across PTY I/O — a blocking `write_all` into a busy agent must not
    /// freeze every other session (and the reaper threads' cleanup `remove`).
    /// Within one session the same holds: `PtySession` locks per control
    /// surface, so kill/resize never queue behind a blocked write either.
    fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .sessions
            .get(id)
            .cloned()
    }

    fn write(&self, id: &str, data: &[u8]) -> io::Result<()> {
        self.get(id).ok_or_else(|| unknown_session(id))?.write(data)
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> io::Result<()> {
        self.get(id)
            .ok_or_else(|| unknown_session(id))?
            .resize(cols, rows)
    }

    /// Terminate a session. Removal happens when its exit event arrives, so a
    /// close of an already-gone session is a no-op success.
    fn kill(&self, id: &str) -> io::Result<()> {
        match self.get(id) {
            Some(session) => session.kill(),
            None => Ok(()),
        }
    }

    /// Take every live session down, because the app is going.
    ///
    /// Closing a PTY does not end what runs behind it. An agent CLI that owns
    /// its own children survives the hangup, and one that outlives the app
    /// keeps whatever it had open — codex holds a writer on its rollout file
    /// and then refuses to resume a thread "another writer" holds, so the
    /// leaked process is what stops the NEXT launch restoring that pane.
    ///
    /// One SIGTERM to every group, then ONE shared wait, then SIGKILL to
    /// whatever is left. A session at a time would cost the grace period per
    /// session, and a deck of eight agents would hang the quit for half a
    /// minute; waited together, quitting costs as long as the slowest agent
    /// takes to shut down, which is normally a fraction of a second.
    pub fn shutdown(&self, grace: Duration) {
        let sessions: Vec<Arc<PtySession>> = {
            let mut reg = self.inner.lock().expect("session registry poisoned");
            reg.sessions.drain().map(|(_, session)| session).collect()
        };
        if sessions.is_empty() {
            return;
        }
        log::info!("shutdown: stopping {} pty session(s)", sessions.len());
        for session in &sessions {
            let _ = session.signal_stop();
        }
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline && sessions.iter().any(|s| !s.has_exited()) {
            thread::sleep(SHUTDOWN_POLL);
        }
        let stubborn = sessions.iter().filter(|s| !s.has_exited()).count();
        for session in &sessions {
            session.force_stop();
        }
        if stubborn > 0 {
            log::warn!("shutdown: {stubborn} session(s) had to be killed");
        }
    }
}

/// How often the shared shutdown wait re-checks. Short enough that quitting a
/// deck of well-behaved agents feels immediate, long enough not to spin.
const SHUTDOWN_POLL: Duration = Duration::from_millis(25);

fn unknown_session(id: &str) -> io::Error {
    io::Error::other(format!("unknown session {id}"))
}

/// Resolve the program to spawn: an explicit non-blank command wins, else the
/// caller's shell, else `/bin/sh`. Pure so it can be unit tested.
fn resolve_command(command: Option<String>, shell: Option<String>) -> String {
    nonblank(command)
        .or_else(|| nonblank(shell))
        .unwrap_or_else(|| "/bin/sh".to_string())
}

fn nonblank(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Spawn a new PTY session, forwarding its events to `on_event`, and return its
/// id. The session removes itself from the registry once it exits.
///
/// `(async)` so the blocking fork/exec runs on Tauri's worker pool, not the
/// main event-loop thread — a slow spawn must never freeze the UI.
#[tauri::command(async)]
pub fn session_spawn(
    app: AppHandle,
    registry: State<SessionRegistry>,
    spec: SpawnSpec,
    on_event: Channel<SessionEvent>,
) -> Result<String, String> {
    let command = resolve_command(spec.command, std::env::var("SHELL").ok());
    // The one line that settles "which build / which args did this pane get"
    // when a session-identity repro comes in. Env values stay private — the
    // key names are what debugging needs.
    log::info!(
        "spawn: cmd={command} args={:?} env={:?} cwd={:?}",
        spec.args,
        spec.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        spec.cwd,
    );
    let pty_spec = PtySpec {
        command,
        args: spec.args,
        env: spec.env,
        env_defaults: spec.env_defaults,
        cwd: spec.cwd.map(PathBuf::from),
        size: TermSize {
            cols: spec.cols,
            rows: spec.rows,
        },
    };

    let (session, events) = PtySession::spawn(pty_spec).map_err(|e| e.to_string())?;
    let id = registry.insert(session);

    let app = app.clone();
    let session_id = id.clone();
    std::thread::spawn(move || {
        let registry = app.state::<SessionRegistry>();
        for event in events {
            let is_exit = matches!(event, PtyEvent::Exited(_));
            if on_event.send(SessionEvent::from(event)).is_err() {
                // Webview dropped the channel (reload/close). Kill the child so
                // its reader/reaper thread sees EOF and exits — otherwise we leak
                // an orphan process + a permanently blocked reaper thread.
                log::debug!("session {session_id}: webview dropped channel, killing child");
                let _ = registry.kill(&session_id);
                break;
            }
            if is_exit {
                break;
            }
        }
        registry.remove(&session_id);
    });

    Ok(id)
}

/// Write input bytes (keystrokes, paste) to a session's PTY.
///
/// `(async)` so a `write_all` that blocks on a stalled agent's stdin (e.g. a
/// large paste) runs on Tauri's worker pool instead of freezing every pane and
/// window on the main thread.
#[tauri::command(async)]
pub fn session_write(
    registry: State<SessionRegistry>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    registry.write(&id, &data).map_err(|e| e.to_string())
}

/// Resize a session's PTY to `cols` x `rows` cells.
#[tauri::command]
pub fn session_resize(
    registry: State<SessionRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry.resize(&id, cols, rows).map_err(|e| e.to_string())
}

/// Terminate a session.
#[tauri::command]
pub fn session_close(registry: State<SessionRegistry>, id: String) -> Result<(), String> {
    registry.kill(&id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_pty::ExitInfo;
    use std::sync::mpsc::Receiver;

    /// A real session running `script`. The receiver is handed back and MUST
    /// be held: the pump thread kills its child the moment a send fails, so a
    /// dropped receiver would end the process for reasons that have nothing
    /// to do with what is being tested.
    #[cfg(unix)]
    fn session(script: &str) -> (PtySession, Receiver<PtyEvent>) {
        PtySession::spawn(PtySpec {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: Vec::new(),
            env_defaults: Vec::new(),
            cwd: None,
            size: TermSize::default(),
        })
        .expect("spawn sh")
    }

    /// Wait for a session's final exit event, or fail. Output events on the
    /// way are discarded — only the ending is the claim.
    #[cfg(unix)]
    fn expect_exit(events: &Receiver<PtyEvent>, within: Duration) {
        let started = Instant::now();
        while started.elapsed() < within {
            if let Ok(PtyEvent::Exited(_)) = events.recv_timeout(Duration::from_millis(50)) {
                return;
            }
        }
        panic!("session outlived the shutdown");
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_ends_every_session_including_one_that_ignores_being_asked() {
        // The leak this exists to close: an agent that survives the hangup
        // keeps its files open, and next launch codex refuses to resume a
        // thread "another writer" holds — that writer being last run's codex.
        let registry = SessionRegistry::default();
        let (polite, polite_events) = session("sleep 30");
        let (stubborn, stubborn_events) = session("trap '' TERM; sleep 30");
        let polite_id = registry.insert(polite);
        let stubborn_id = registry.insert(stubborn);

        registry.shutdown(Duration::from_millis(500));

        expect_exit(&polite_events, Duration::from_secs(5));
        expect_exit(&stubborn_events, Duration::from_secs(5));
        // And nothing is left claiming to be live: the registry is the only
        // record of these processes, and one that outlived them would have a
        // later close signalling a recycled pid.
        assert!(registry.get(&polite_id).is_none());
        assert!(registry.get(&stubborn_id).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_waits_for_the_sessions_together_not_one_after_another() {
        // Quitting must not cost the grace period per pane. Two agents that
        // both go on SIGTERM have to be gone in about the time one takes.
        let registry = SessionRegistry::default();
        let (first, first_events) = session("sleep 30");
        let (second, second_events) = session("sleep 30");
        registry.insert(first);
        registry.insert(second);

        // A grace far longer than anything a `sleep` takes to die, so the
        // claim rests on the GAP rather than on absolute timing: a wait that
        // ran its full length would take half a minute, and one that ends
        // when the sessions do takes a moment even on a loaded machine.
        let started = Instant::now();
        registry.shutdown(Duration::from_secs(30));
        let waited = started.elapsed();

        expect_exit(&first_events, Duration::from_secs(5));
        expect_exit(&second_events, Duration::from_secs(5));
        assert!(
            waited < Duration::from_secs(5),
            "waited {waited:?} of a 30s grace for two prompt exits — the wait is not shared",
        );
    }

    #[test]
    fn shutdown_of_an_empty_registry_does_nothing_at_all() {
        let started = Instant::now();
        SessionRegistry::default().shutdown(Duration::from_secs(3));
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    /// The webview sends camelCase keys; the FIELD names are raw serde (no
    /// Tauri conversion) — this pins the wire shape end to end, especially
    /// the multi-word `envDefaults`. MIRROR: src/ipc/session.test.ts pins
    /// the same shape from the sending side — change both together.
    #[test]
    fn spawn_spec_deserializes_the_webviews_camel_case_wire() {
        let spec: SpawnSpec = serde_json::from_str(
            r#"{
                "command": "opencode",
                "args": ["-s", "x"],
                "env": [["A", "1"]],
                "envDefaults": [["OPENCODE_CONFIG_DIR", "/kd/opencode/ws-1"]],
                "cwd": "/repo",
                "cols": 80,
                "rows": 24
            }"#,
        )
        .unwrap();
        assert_eq!(
            spec.env_defaults,
            vec![("OPENCODE_CONFIG_DIR".to_string(), "/kd/opencode/ws-1".to_string())],
        );
        // And the snake_case spelling must NOT be accepted silently.
        let wrong: SpawnSpec = serde_json::from_str(
            r#"{"command": null, "args": [], "env": [],
                "env_defaults": [["K", "V"]], "cwd": null, "cols": 1, "rows": 1}"#,
        )
        .unwrap_or_else(|_| SpawnSpec {
            command: None,
            args: vec![],
            env: vec![],
            env_defaults: vec![],
            cwd: None,
            cols: 1,
            rows: 1,
        });
        assert!(wrong.env_defaults.is_empty());
    }

    #[test]
    fn explicit_command_wins() {
        assert_eq!(
            resolve_command(Some("zsh".into()), Some("/bin/bash".into())),
            "zsh"
        );
    }

    #[test]
    fn falls_back_to_shell_then_sh() {
        assert_eq!(resolve_command(None, Some("/bin/bash".into())), "/bin/bash");
        assert_eq!(resolve_command(None, None), "/bin/sh");
    }

    #[test]
    fn blank_command_or_shell_is_ignored() {
        assert_eq!(
            resolve_command(Some("   ".into()), Some("/bin/bash".into())),
            "/bin/bash"
        );
        assert_eq!(resolve_command(None, Some("".into())), "/bin/sh");
    }

    #[test]
    fn maps_pty_events_to_dtos() {
        assert_eq!(
            SessionEvent::from(PtyEvent::Output(vec![1, 2, 3])),
            SessionEvent::Output {
                bytes: vec![1, 2, 3]
            }
        );
        assert_eq!(
            SessionEvent::from(PtyEvent::Exited(ExitInfo {
                success: true,
                code: Some(0)
            })),
            SessionEvent::Exit {
                success: true,
                code: Some(0)
            }
        );
    }
}
