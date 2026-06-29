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
use std::sync::Mutex;

use keepdeck_pty::{PtyEvent, PtySession, PtySpec, TermSize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Request DTO for [`session_spawn`]. `command` defaults to the user's shell.
#[derive(Debug, Deserialize)]
pub struct SpawnSpec {
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
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
    sessions: HashMap<String, PtySession>,
    next: u64,
}

impl SessionRegistry {
    /// Store a session under a fresh monotonic id and return the id.
    fn insert(&self, session: PtySession) -> String {
        let mut reg = self.inner.lock().expect("session registry poisoned");
        reg.next += 1;
        let id = format!("s{}", reg.next);
        reg.sessions.insert(id.clone(), session);
        id
    }

    fn remove(&self, id: &str) {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .sessions
            .remove(id);
    }

    fn write(&self, id: &str, data: &[u8]) -> io::Result<()> {
        let mut reg = self.inner.lock().expect("session registry poisoned");
        match reg.sessions.get_mut(id) {
            Some(session) => session.write(data),
            None => Err(unknown_session(id)),
        }
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> io::Result<()> {
        let reg = self.inner.lock().expect("session registry poisoned");
        match reg.sessions.get(id) {
            Some(session) => session.resize(cols, rows),
            None => Err(unknown_session(id)),
        }
    }

    /// Terminate a session. Removal happens when its exit event arrives, so a
    /// close of an already-gone session is a no-op success.
    fn kill(&self, id: &str) -> io::Result<()> {
        let mut reg = self.inner.lock().expect("session registry poisoned");
        match reg.sessions.get_mut(id) {
            Some(session) => session.kill(),
            None => Ok(()),
        }
    }
}

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
#[tauri::command]
pub fn session_spawn(
    app: AppHandle,
    registry: State<SessionRegistry>,
    spec: SpawnSpec,
    on_event: Channel<SessionEvent>,
) -> Result<String, String> {
    let command = resolve_command(spec.command, std::env::var("SHELL").ok());
    let pty_spec = PtySpec {
        command,
        args: spec.args,
        env: spec.env,
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
#[tauri::command]
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
