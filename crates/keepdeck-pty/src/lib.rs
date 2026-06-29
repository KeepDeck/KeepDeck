//! `keepdeck-pty` — the process layer for KeepDeck.
//!
//! A [`PtySession`] spawns a command in a pseudo-terminal and streams its output
//! as [`PtyEvent`]s over a channel, while accepting input, resize, and kill. It
//! is pure Rust over `portable-pty` with NO dependency on Tauri or any UI — the
//! delivery layer (the Tauri app) forwards these events to the webview.
//!
//! Adapted from AnyClaude's `ChildPty`, reimplemented and owned here: dropped the
//! anyclaude debug-trace hook and the winit-shaped `drain()` polling model, and
//! added child-exit signaling (needed for per-pane status). Output and the final
//! `Exited` are emitted from the same reader thread, so all output is guaranteed
//! to arrive before the exit event.

mod path;

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize,
};

/// Cap on buffered PTY events per session. Bounds memory under a flooding child
/// (each event is one read of up to 4 KiB) while leaving generous headroom; a
/// full channel backpressures the pump thread instead of growing without limit.
const EVENT_CHANNEL_CAP: usize = 1024;

/// Terminal size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for TermSize {
    /// A conventional 80x24 terminal.
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

/// What to spawn in a pane's PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySpec {
    /// Program to run (e.g. the user's shell, or a coding-agent CLI).
    pub command: String,
    /// Arguments to `command`.
    pub args: Vec<String>,
    /// Extra environment for the child, on top of the inherited environment.
    pub env: Vec<(String, String)>,
    /// Working directory; defaults to the host process's cwd when `None`.
    pub cwd: Option<PathBuf>,
    /// Initial terminal size.
    pub size: TermSize,
}

impl PtySpec {
    /// A bare session that just runs `command` (no args/env) at `size`.
    pub fn command(command: impl Into<String>, size: TermSize) -> Self {
        Self {
            command: command.into(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            size,
        }
    }
}

/// How a child process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    /// Whether the process exited successfully (status 0, not killed).
    pub success: bool,
    /// The exit code, when one is available (absent if the wait itself failed).
    pub code: Option<u32>,
}

/// An ordered event from a running session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// A chunk of raw output bytes read from the PTY master.
    Output(Vec<u8>),
    /// The child exited; emitted after all `Output`, and is always last.
    Exited(ExitInfo),
}

/// A live PTY-backed session.
///
/// Dropping the handle leaves the child running until it exits on its own (the
/// reader thread ends on EOF and emits [`PtyEvent::Exited`]); call [`kill`] to
/// terminate it.
///
/// [`kill`]: PtySession::kill
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Child pid, for the SIGTERM→SIGKILL escalation in [`kill`](Self::kill) (Unix).
    pid: Option<u32>,
    /// Set by the reaper once the child is waited on, so `kill`'s escalation
    /// timer never signals an already-reaped (possibly recycled) pid.
    exited: Arc<AtomicBool>,
}

impl PtySession {
    /// Spawn `spec` in a fresh PTY. Returns the session handle and a receiver of
    /// its events: zero or more [`PtyEvent::Output`] chunks followed by exactly
    /// one final [`PtyEvent::Exited`].
    pub fn spawn(spec: PtySpec) -> io::Result<(Self, Receiver<PtyEvent>)> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(pty_size(spec.size.cols, spec.size.rows))
            .map_err(to_io)?;

        // Rebuild PATH so a GUI-launched (stripped-PATH) instance finds the
        // user's CLIs, and resolve the program against it (CommandBuilder won't
        // search our augmented PATH for a bare name on its own).
        let path_env = path::augmented_path();
        let mut cmd = CommandBuilder::new(path::resolve_program(&spec.command, path_env));
        cmd.args(&spec.args);
        cmd.cwd(match spec.cwd {
            Some(dir) => dir,
            None => std::env::current_dir()?,
        });
        cmd.env("PATH", path_env);
        cmd.env("TERM", "xterm-256color");
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(to_io)?;
        // Drop the slave so the master reports EOF once the child closes its end.
        drop(pair.slave);

        let killer = child.clone_killer();
        let pid = child.process_id();
        // A failure after the child has spawned must not leak it — dropping the
        // handle leaves it running per this crate's contract, so kill + reap on
        // each error path.
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(to_io(e));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(to_io(e));
            }
        };

        let exited = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel::<PtyEvent>(EVENT_CHANNEL_CAP);
        spawn_pump(reader, child, tx, exited.clone());

        Ok((
            Self {
                master: pair.master,
                writer,
                killer,
                pid,
                exited,
            },
            rx,
        ))
    }

    /// Write input bytes to the PTY (keystrokes, pasted text).
    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    /// Resize the PTY to `cols` x `rows` character cells.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.master.resize(pty_size(cols, rows)).map_err(to_io)
    }

    /// Terminate the child: SIGTERM now, then SIGKILL after a grace period if
    /// it's still alive — so a well-behaved agent can clean up, but a trap that
    /// swallows the signal can't survive a close. (A bare `ChildKiller::kill`
    /// only sends a catchable SIGHUP.)
    pub fn kill(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // Already reaped → nothing to signal (and avoids a recycled pid).
            if self.exited.load(Ordering::Relaxed) {
                return Ok(());
            }
            let pid = pid as i32;
            // SAFETY: kill(2) on a child we own; harmless ESRCH if already gone.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let exited = self.exited.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                if !exited.load(Ordering::Relaxed) {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            });
            return Ok(());
        }
        // No pid, or non-Unix: fall back to the killer's signal.
        self.killer.kill()
    }
}

/// Reader + reaper thread: streams output, then waits for exit and emits it last.
/// Owning `child` here (rather than a separate waiter thread) is what guarantees
/// every `Output` precedes the `Exited` event.
fn spawn_pump(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    tx: SyncSender<PtyEvent>,
    exited: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(PtyEvent::Output(buf[..n].to_vec())).is_err() {
                        // Receiver dropped (webview gone): kill the child first so
                        // it stops writing — otherwise wait() blocks forever on an
                        // undrained PTY the child keeps filling — then reap it.
                        let _ = child.kill();
                        let _ = child.wait();
                        exited.store(true, Ordering::Relaxed);
                        return;
                    }
                }
                Err(_) => break,
            }
        }

        let info = match child.wait() {
            Ok(status) => ExitInfo {
                success: status.success(),
                code: Some(status.exit_code()),
            },
            Err(_) => ExitInfo {
                success: false,
                code: None,
            },
        };
        exited.store(true, Ordering::Relaxed);
        let _ = tx.send(PtyEvent::Exited(info));
    });
}

/// Build a `PtySize` of `cols` x `rows` cells (pixel dimensions unused).
fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Map `portable-pty`'s error type into `io::Error` so the crate's surface is
/// std-only.
fn to_io<E: std::fmt::Display>(err: E) -> io::Error {
    io::Error::other(err.to_string())
}
