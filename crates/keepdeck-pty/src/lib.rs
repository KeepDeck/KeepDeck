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

mod output;

pub use output::{parse_drop_marker, Consumer, OutputQueue, Producer, PushOutcome, OUTPUT_CAP_BYTES};

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize,
};

/// How long a child gets between being asked to stop and being made to.
///
/// It has to cover the CLI's own shutdown, not just the shell's: an agent
/// flushes its transcript and releases the lock it holds on its session file
/// on the way out, and one killed before it can is exactly the state that
/// refuses to resume afterwards.
pub const STOP_GRACE: Duration = Duration::from_secs(3);

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
    /// Environment DEFAULTS: applied only when the key is absent from the
    /// inherited environment, so a value the user set themselves (shell
    /// profile, launchctl) is never silently overridden. Applied before
    /// `env`, which always wins.
    pub env_defaults: Vec<(String, String)>,
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
            env_defaults: Vec::new(),
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
/// All methods take `&self` and each control surface guards only its own
/// state: a `write_all` blocked on a full PTY input buffer (a child that
/// stopped draining stdin) must never delay [`kill`] or [`resize`] — one lock
/// across all three turned a hung agent into an uncloseable pane.
///
/// [`kill`]: PtySession::kill
/// [`resize`]: PtySession::resize
pub struct PtySession {
    /// Resize path — independent of the writer.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Write path — the only lock a blocking `write_all` holds.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Kill fallback (non-Unix / no pid); the Unix path needs no lock at all.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Child pid — the group id every signal below is aimed at (Unix).
    pid: Option<u32>,
    /// Set by the reaper once the child is waited on, so `kill`'s escalation
    /// timer never signals an already-reaped (possibly recycled) pid.
    exited: Arc<AtomicBool>,
}

impl PtySession {
    /// Spawn `spec` in a fresh PTY. Returns the session handle and the reading
    /// end of its events: zero or more [`PtyEvent::Output`] chunks followed by
    /// exactly one final [`PtyEvent::Exited`].
    ///
    /// Dropping the [`Consumer`] tells the reader thread nobody is listening,
    /// and it stops and reaps the child rather than reading into a void.
    pub fn spawn(spec: PtySpec) -> io::Result<(Self, Consumer)> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(pty_size(spec.size.cols, spec.size.rows))
            .map_err(to_io)?;

        // Rebuild PATH so a GUI-launched (stripped-PATH) instance finds the
        // user's CLIs, and resolve the program against it (CommandBuilder won't
        // search our augmented PATH for a bare name on its own).
        let path_env = keepdeck_env::augmented_path();
        let mut cmd = CommandBuilder::new(keepdeck_env::resolve_program(&spec.command, path_env));
        cmd.args(&spec.args);
        cmd.cwd(match spec.cwd {
            Some(dir) => dir,
            None => std::env::current_dir()?,
        });
        cmd.env("PATH", path_env);
        cmd.env("TERM", "xterm-256color");
        // A UTF-8 locale when the inherited environment selects none (GUI
        // launch), or locale-sensitive tools in the pane — pbcopy above all —
        // treat text as MacRoman and garble every non-ASCII copy.
        if let Some(lang) = keepdeck_env::utf8_lang() {
            cmd.env("LANG", lang);
        }
        for (key, value) in &spec.env_defaults {
            if std::env::var_os(key).is_none() {
                cmd.env(key, value);
            }
        }
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
        let (producer, consumer) = OutputQueue::new(OUTPUT_CAP_BYTES).split();
        spawn_pump(reader, child, producer, exited.clone());

        Ok((
            Self {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                killer: Mutex::new(killer),
                pid,
                exited,
            },
            consumer,
        ))
    }

    /// Write input bytes to the PTY (keystrokes, pasted text). May block until
    /// the child drains its stdin; only the writer lock is held meanwhile.
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = self.writer.lock().expect("pty writer poisoned");
        writer.write_all(bytes)?;
        writer.flush()
    }

    /// Resize the PTY to `cols` x `rows` character cells.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.master
            .lock()
            .expect("pty master poisoned")
            .resize(pty_size(cols, rows))
            .map_err(to_io)
    }

    /// Whether the child has been reaped.
    ///
    /// The reaper sets it in the same breath as the exit event, so this is
    /// also the only safe guard on signalling: once a group empties, the
    /// kernel may recycle its id, and a late signal would land on a stranger.
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Relaxed)
    }

    /// Ask the child's whole tree to stop, and return without waiting.
    ///
    /// SIGTERM rather than the bare `ChildKiller::kill`, which only sends a
    /// catchable SIGHUP — and a CLI that holds its own children survives one.
    /// The Unix path takes no lock, so this always lands even while a write is
    /// blocked on a hung child.
    ///
    /// The signal goes to the child's process GROUP: the PTY spawn made the
    /// child a session leader (its pid doubles as the pgid), and a non-
    /// interactive `sh -c` runs without job control, so a run command's whole
    /// tree — `&`-backgrounded children included — shares that group. Killing
    /// only the leader let those children outlive the pane. A process that
    /// double-forks out of the session (a self-daemonizer) is beyond any
    /// group signal; that one is out of scope by design.
    pub fn signal_stop(&self) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            if self.has_exited() {
                return Ok(());
            }
            signal_tree(pid as i32, libc::SIGTERM);
            return Ok(());
        }
        // No pid, or non-Unix: fall back to the killer's signal.
        self.killer.lock().expect("pty killer poisoned").kill()
    }

    /// End the child's whole tree outright. Nothing survives SIGKILL and
    /// nothing gets to clean up, so this is the last resort after
    /// [`signal_stop`] and [`STOP_GRACE`] have gone by.
    pub fn force_stop(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            if self.has_exited() {
                return;
            }
            signal_tree(pid as i32, libc::SIGKILL);
        }
    }

    /// Terminate the child: [`signal_stop`] now, [`force_stop`] after
    /// [`STOP_GRACE`] if it is still alive — so a well-behaved agent can clean
    /// up, but a trap that swallows the signal can't survive a close.
    ///
    /// Returns immediately; the escalation runs on its own thread, because the
    /// caller is a pane closing and must not sit through the grace period.
    /// A caller taking down MANY sessions at once wants the primitives instead
    /// — one shared wait rather than one per session.
    ///
    /// [`signal_stop`]: Self::signal_stop
    /// [`force_stop`]: Self::force_stop
    pub fn kill(&self) -> io::Result<()> {
        self.signal_stop()?;
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let (pid, exited) = (pid as i32, self.exited.clone());
            thread::spawn(move || {
                thread::sleep(STOP_GRACE);
                if !exited.load(Ordering::Relaxed) {
                    signal_tree(pid, libc::SIGKILL);
                }
            });
        }
        Ok(())
    }
}

/// Reader + reaper thread: streams output, then waits for exit and emits it last.
/// Owning `child` here (rather than a separate waiter thread) is what guarantees
/// every `Output` precedes the `Exited` event.
///
/// The loop never waits on the queue. That is the whole point of the queue: a
/// master left unread stalls the child within a kilobyte, so anything that can
/// pause this thread can freeze a live agent. Output lost to the queue's cap is
/// marked in the stream and is not this thread's concern.
fn spawn_pump(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    producer: Producer,
    exited: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let outcome = producer.push(PtyEvent::Output(buf[..n].to_vec()));
                    if outcome == PushOutcome::ConsumerGone {
                        // Nobody is listening (webview gone): kill the child first
                        // so it stops writing — otherwise wait() blocks forever on
                        // an undrained PTY the child keeps filling — then reap it.
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
        producer.push(PtyEvent::Exited(info));
    });
}

/// Send `sig` to the process group led by `pid`, falling back to the lone
/// process when the group signal is refused (ESRCH: the group dissolved
/// between the liveness check and this call).
#[cfg(unix)]
fn signal_tree(pid: i32, sig: libc::c_int) {
    // SAFETY: kill(2) on a group/process we spawned; ESRCH is harmless.
    unsafe {
        if libc::kill(-pid, sig) != 0 {
            libc::kill(pid, sig);
        }
    }
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
