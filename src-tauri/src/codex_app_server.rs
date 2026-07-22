//! Shared Codex app-server transport.
//!
//! KeepDeck needs account limits without disturbing a pane, but it must not
//! spawn one `codex app-server` per poll. This manager is Tauri app-scoped;
//! its worker owns one lazily-started stdio child, initializes each child
//! generation once, routes JSON-RPC responses by id, and reaps the child
//! after an idle grace period. The worker itself lives until KeepDeck exits.
//!
//! Only the narrow rate-limits command crosses IPC. The generic JSON-RPC
//! request surface stays native so a plugin can never turn the user's Codex
//! credentials into an arbitrary local capability.

use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::State;

const IDLE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_STDERR_BYTES: usize = 32 * 1024;

#[derive(Clone)]
pub struct CodexAppServerManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    commands: Sender<WorkerCommand>,
    worker: Mutex<Option<JoinHandle<()>>>,
    response_timeout: Duration,
}

impl Drop for ManagerInner {
    fn drop(&mut self) {
        let _ = self.commands.send(WorkerCommand::Shutdown);
        if let Some(worker) = self.worker.lock().expect("codex worker poisoned").take() {
            let _ = worker.join();
        }
    }
}

impl Default for CodexAppServerManager {
    fn default() -> Self {
        Self::new(WorkerConfig::production())
    }
}

impl CodexAppServerManager {
    fn new(config: WorkerConfig) -> Self {
        let response_timeout =
            config.startup_timeout + config.request_timeout + Duration::from_secs(1);
        let (commands, receiver) = mpsc::channel();
        let server_events = commands.clone();
        let worker = thread::Builder::new()
            .name("keepdeck codex app-server".into())
            .spawn(move || Worker::new(config, receiver, server_events).run())
            .expect("codex app-server manager thread must start");
        Self {
            inner: Arc::new(ManagerInner {
                commands,
                worker: Mutex::new(Some(worker)),
                response_timeout,
            }),
        }
    }

    fn request(&self, method: &str, params: Option<Value>) -> Result<TimedResponse, String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.inner
            .commands
            .send(WorkerCommand::Request(ClientRequest {
                method: method.to_string(),
                params,
                reply,
            }))
            .map_err(|_| "codex app-server manager stopped".to_string())?;
        response
            .recv_timeout(self.inner.response_timeout)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => "codex app-server manager timed out".to_string(),
                RecvTimeoutError::Disconnected => "codex app-server manager stopped".to_string(),
            })?
    }

    fn read_rate_limits(&self) -> Result<CodexRateLimitsRead, String> {
        let response = self.request("account/rateLimits/read", None)?;
        let body = serde_json::to_string(&response.result)
            .map_err(|error| format!("codex rate-limits response was not serializable: {error}"))?;
        Ok(CodexRateLimitsRead {
            body,
            source_at: response.source_at,
        })
    }
}

/// Opaque app-server body plus the earliest instant at which that particular
/// JSON-RPC read could have observed the backend. Unlike a timestamp captured
/// in the webview, this is recorded AFTER a cold child has initialized and
/// immediately before the request is written to its stdin.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitsRead {
    body: String,
    source_at: u64,
}

/// Return one current Codex account rate-limit snapshot. The manager owns
/// auth indirectly: the official app-server reads Codex's own credentials;
/// KeepDeck never reads or forwards `auth.json` itself.
#[tauri::command(async)]
pub async fn codex_rate_limits_read(
    manager: State<'_, CodexAppServerManager>,
) -> Result<CodexRateLimitsRead, String> {
    let manager = CodexAppServerManager {
        inner: Arc::clone(&manager.inner),
    };
    tauri::async_runtime::spawn_blocking(move || manager.read_rate_limits())
        .await
        .map_err(|error| format!("codex rate-limits task failed: {error}"))?
}

struct ClientRequest {
    method: String,
    params: Option<Value>,
    reply: SyncSender<Result<TimedResponse, String>>,
}

struct TimedResponse {
    result: Value,
    source_at: u64,
}

enum WorkerCommand {
    Request(ClientRequest),
    ServerMessage { generation: u64, message: Value },
    ServerClosed { generation: u64, reason: String },
    Shutdown,
}

#[derive(Clone)]
struct WorkerConfig {
    launcher: Arc<dyn ServerLauncher>,
    idle_timeout: Duration,
    startup_timeout: Duration,
    request_timeout: Duration,
}

impl WorkerConfig {
    fn production() -> Self {
        let path = keepdeck_env::augmented_path();
        Self {
            launcher: Arc::new(StdioLauncher {
                command: codex_command(path),
            }),
            idle_timeout: IDLE_TIMEOUT,
            startup_timeout: STARTUP_TIMEOUT,
            request_timeout: REQUEST_TIMEOUT,
        }
    }
}

fn codex_command(path: &OsStr) -> CommandSpec {
    CommandSpec {
        // Match agent detection and pane spawning exactly: a GUI-launched
        // macOS app otherwise sees launchd's stripped PATH and can report
        // Codex installed while this sidecar still fails to resolve it.
        program: keepdeck_env::resolve_program("codex", path),
        // stdio is the default app-server transport. Avoiding a newer
        // `--listen` flag keeps the fallback compatible with the widest
        // useful range of installed Codex CLIs.
        args: vec![OsString::from("app-server")],
        env: vec![(OsString::from("PATH"), path.to_os_string())],
    }
}

trait ServerLauncher: Send + Sync {
    fn start(
        &self,
        generation: u64,
        events: Sender<WorkerCommand>,
    ) -> Result<Box<dyn ServerTransport>, String>;
}

trait ServerTransport: Send {
    fn send(&mut self, message: &Value) -> Result<(), String>;
    /// Stop and reap the child, returning its fully-drained bounded stderr
    /// tail. Fakes return `None`; production uses it to enrich the failure
    /// only after stdout and stderr have both settled.
    fn stop(&mut self) -> Option<String>;
}

#[derive(Clone)]
struct CommandSpec {
    program: OsString,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

struct StdioLauncher {
    command: CommandSpec,
}

type StderrTail = Arc<Mutex<Vec<u8>>>;

fn append_stderr(tail: &StderrTail, bytes: &[u8]) {
    let Ok(mut tail) = tail.lock() else {
        return;
    };
    tail.extend_from_slice(bytes);
    let overflow = tail.len().saturating_sub(MAX_STDERR_BYTES);
    if overflow > 0 {
        tail.drain(..overflow);
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn append_stderr_reason(reason: String, stderr: Option<String>) -> String {
    match stderr {
        Some(stderr) => format!("{reason}; stderr: {stderr}"),
        None => reason,
    }
}

impl ServerLauncher for StdioLauncher {
    fn start(
        &self,
        generation: u64,
        events: Sender<WorkerCommand>,
    ) -> Result<Box<dyn ServerTransport>, String> {
        let mut command = Command::new(&self.command.program);
        command
            .args(&self.command.args)
            .envs(self.command.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stdout remains the protocol. stderr is drained independently
            // into a bounded diagnostic tail so a verbose child cannot block
            // and startup/version/auth failures keep their useful context.
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("could not start codex app-server: {error}"))?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("codex app-server opened no stdin".into());
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("codex app-server opened no stdout".into());
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("codex app-server opened no stderr".into());
        };

        let stderr_tail: StderrTail = Arc::new(Mutex::new(Vec::new()));
        let stderr_sink = Arc::clone(&stderr_tail);
        let stderr_reader = thread::Builder::new()
            .name("keepdeck codex app-server stderr".into())
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut chunk = [0_u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(read) => append_stderr(&stderr_sink, &chunk[..read]),
                    }
                }
            })
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                format!("codex app-server stderr reader failed to start: {error}")
            })?;

        if let Err(error) = thread::Builder::new()
            .name("keepdeck codex app-server stdout".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line = match line {
                        Ok(line) => line,
                        Err(error) => {
                            let _ = events.send(WorkerCommand::ServerClosed {
                                generation,
                                reason: format!("codex app-server stdout failed: {error}"),
                            });
                            return;
                        }
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let message = match serde_json::from_str(&line) {
                        Ok(message) => message,
                        Err(error) => {
                            let _ = events.send(WorkerCommand::ServerClosed {
                                generation,
                                reason: format!("codex app-server wrote invalid JSON: {error}"),
                            });
                            return;
                        }
                    };
                    if events
                        .send(WorkerCommand::ServerMessage {
                            generation,
                            message,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                let _ = events.send(WorkerCommand::ServerClosed {
                    generation,
                    reason: "codex app-server closed its stdout".into(),
                });
            })
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(format!(
                "codex app-server stdout reader failed to start: {error}"
            ));
        }

        Ok(Box::new(StdioTransport {
            child,
            stdin: Some(stdin),
            stderr_reader: Some(stderr_reader),
            stderr_tail,
        }))
    }
}

struct StdioTransport {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr_tail: StderrTail,
}

impl ServerTransport for StdioTransport {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or("codex app-server stdin is closed")?;
        serde_json::to_writer(&mut *stdin, message)
            .map_err(|error| format!("codex app-server request encode failed: {error}"))?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("codex app-server stdin failed: {error}"))
    }

    fn stop(&mut self) -> Option<String> {
        // EOF is app-server's supported clean shutdown. Give it a small,
        // bounded grace period to release its own resources before the hard
        // kill fallback, then always reap it — no app-server zombies.
        self.stdin.take();
        let deadline = Instant::now() + GRACEFUL_SHUTDOWN_TIMEOUT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(SHUTDOWN_POLL_INTERVAL);
                }
                Ok(None) | Err(_) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
        let detail = self.stderr_tail.lock().ok().and_then(|tail| {
            let detail = String::from_utf8_lossy(&tail).trim().to_string();
            (!detail.is_empty()).then_some(detail)
        });
        detail
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct PendingRequest {
    reply: SyncSender<Result<TimedResponse, String>>,
    deadline: Instant,
    source_at: u64,
}

enum ServerPhase {
    Initializing { request_id: u64, deadline: Instant },
    Ready,
}

struct RunningServer {
    generation: u64,
    transport: Box<dyn ServerTransport>,
    phase: ServerPhase,
    queued: VecDeque<ClientRequest>,
    pending: HashMap<u64, PendingRequest>,
    next_request_id: u64,
    last_activity: Instant,
}

impl RunningServer {
    fn send_raw(&mut self, message: Value) -> Result<(), String> {
        self.transport.send(&message)
    }

    fn send_client(&mut self, request: ClientRequest, timeout: Duration) -> Result<(), String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        let mut message = json!({ "method": request.method, "id": id });
        if let Some(params) = request.params {
            message["params"] = params;
        }
        self.pending.insert(
            id,
            PendingRequest {
                reply: request.reply,
                deadline: Instant::now() + timeout,
                // This lower bound is deliberately adjacent to the real
                // write, after initialization/queueing rather than at the
                // webview trigger that may precede a cold start by seconds.
                source_at: unix_time_ms(),
            },
        );
        self.send_raw(message)
    }
}

struct Worker {
    config: WorkerConfig,
    commands: Receiver<WorkerCommand>,
    server_events: Sender<WorkerCommand>,
    server: Option<RunningServer>,
    next_generation: u64,
}

impl Worker {
    fn new(
        config: WorkerConfig,
        commands: Receiver<WorkerCommand>,
        server_events: Sender<WorkerCommand>,
    ) -> Self {
        Self {
            config,
            commands,
            server_events,
            server: None,
            next_generation: 1,
        }
    }

    fn run(mut self) {
        loop {
            let received = match self.next_wait() {
                Some(wait) => match self.commands.recv_timeout(wait) {
                    Ok(command) => Some(command),
                    Err(RecvTimeoutError::Timeout) => {
                        self.handle_deadlines();
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => None,
                },
                None => self.commands.recv().ok(),
            };
            let Some(command) = received else {
                self.stop_server(Some("codex app-server manager stopped"));
                return;
            };
            match command {
                WorkerCommand::Request(request) => self.handle_request(request),
                WorkerCommand::ServerMessage {
                    generation,
                    message,
                } => self.handle_server_message(generation, message),
                WorkerCommand::ServerClosed { generation, reason } => {
                    if self.server.as_ref().map(|server| server.generation) == Some(generation) {
                        self.stop_server(Some(&reason));
                    }
                }
                WorkerCommand::Shutdown => {
                    self.stop_server(Some("codex app-server manager stopped"));
                    return;
                }
            }
        }
    }

    fn handle_request(&mut self, request: ClientRequest) {
        // `recv_timeout` may return a newly queued request even when the
        // timeout elapsed first if the worker was not scheduled at the idle
        // deadline. Re-check here so a late request cannot revive an expired
        // generation merely because both events became observable together.
        self.stop_server_if_idle(Instant::now());
        if self.server.is_none() {
            if let Err(error) = self.start_server() {
                let _ = request.reply.send(Err(error));
                return;
            }
        }

        let mut write_error = None;
        if let Some(server) = self.server.as_mut() {
            match server.phase {
                ServerPhase::Initializing { .. } => server.queued.push_back(request),
                ServerPhase::Ready => {
                    server.last_activity = Instant::now();
                    if let Err(error) = server.send_client(request, self.config.request_timeout) {
                        write_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = write_error {
            self.stop_server(Some(&error));
        }
    }

    fn start_server(&mut self) -> Result<(), String> {
        let generation = self.next_generation;
        self.next_generation += 1;
        let transport = self
            .config
            .launcher
            .start(generation, self.server_events.clone())?;
        let now = Instant::now();
        let initialize_id = 1;
        let mut server = RunningServer {
            generation,
            transport,
            phase: ServerPhase::Initializing {
                request_id: initialize_id,
                deadline: now + self.config.startup_timeout,
            },
            queued: VecDeque::new(),
            pending: HashMap::new(),
            next_request_id: initialize_id + 1,
            last_activity: now,
        };
        if let Err(error) = server.send_raw(json!({
            "method": "initialize",
            "id": initialize_id,
            "params": {
                "clientInfo": {
                    "name": "keepdeck",
                    "title": "KeepDeck",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        })) {
            let stderr = server.transport.stop();
            return Err(append_stderr_reason(error, stderr));
        }
        self.server = Some(server);
        Ok(())
    }

    fn handle_server_message(&mut self, generation: u64, message: Value) {
        if self.server.as_ref().map(|server| server.generation) != Some(generation) {
            return; // late output from a reaped generation
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            // Notifications are intentionally consumed by the shared
            // protocol router even though today's usage lane remains poll-
            // driven. No second reader may race stdout for them.
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                log::trace!("codex app-server notification: {method}");
            }
            return;
        };

        let initializing = matches!(
            self.server.as_ref().map(|server| &server.phase),
            Some(ServerPhase::Initializing { request_id, .. }) if *request_id == id
        );
        if initializing {
            match response_result(&message) {
                Ok(_) => {
                    let initialized = self
                        .server
                        .as_mut()
                        .expect("generation checked above")
                        .send_raw(json!({ "method": "initialized", "params": {} }));
                    if let Err(error) = initialized {
                        self.stop_server(Some(&error));
                        return;
                    }
                    let server = self.server.as_mut().expect("generation checked above");
                    server.phase = ServerPhase::Ready;
                    server.last_activity = Instant::now();
                    self.flush_queued();
                }
                Err(error) => self.stop_server(Some(&format!(
                    "codex app-server initialization failed: {error}"
                ))),
            }
            return;
        }

        let pending = self
            .server
            .as_mut()
            .and_then(|server| server.pending.remove(&id));
        if let Some(pending) = pending {
            if let Some(server) = self.server.as_mut() {
                server.last_activity = Instant::now();
            }
            let response = response_result(&message).map(|result| TimedResponse {
                result,
                source_at: pending.source_at,
            });
            let _ = pending.reply.send(response);
        }
    }

    fn flush_queued(&mut self) {
        let mut write_error = None;
        if let Some(server) = self.server.as_mut() {
            while let Some(request) = server.queued.pop_front() {
                if let Err(error) = server.send_client(request, self.config.request_timeout) {
                    write_error = Some(error);
                    break;
                }
            }
        }
        if let Some(error) = write_error {
            self.stop_server(Some(&error));
        }
    }

    fn next_wait(&self) -> Option<Duration> {
        let server = self.server.as_ref()?;
        let mut deadline = match server.phase {
            ServerPhase::Initializing { deadline, .. } => Some(deadline),
            ServerPhase::Ready if server.pending.is_empty() && server.queued.is_empty() => {
                Some(server.last_activity + self.config.idle_timeout)
            }
            ServerPhase::Ready => None,
        };
        for pending in server.pending.values() {
            deadline = Some(match deadline {
                Some(current) => current.min(pending.deadline),
                None => pending.deadline,
            });
        }
        deadline.map(|at| at.saturating_duration_since(Instant::now()))
    }

    fn handle_deadlines(&mut self) {
        let Some(server) = self.server.as_ref() else {
            return;
        };
        let now = Instant::now();
        let failure = match server.phase {
            ServerPhase::Initializing { deadline, .. } if now >= deadline => {
                Some("codex app-server initialization timed out")
            }
            _ if server
                .pending
                .values()
                .any(|pending| now >= pending.deadline) =>
            {
                Some("codex app-server request timed out")
            }
            _ => None,
        };
        if let Some(failure) = failure {
            self.stop_server(Some(failure));
            return;
        }
        self.stop_server_if_idle(now);
    }

    fn stop_server_if_idle(&mut self, now: Instant) {
        let expired = self.server.as_ref().is_some_and(|server| {
            matches!(server.phase, ServerPhase::Ready)
                && server.pending.is_empty()
                && server.queued.is_empty()
                && now.saturating_duration_since(server.last_activity) >= self.config.idle_timeout
        });
        if expired {
            self.stop_server(None);
        }
    }

    fn stop_server(&mut self, failure: Option<&str>) {
        let Some(mut server) = self.server.take() else {
            return;
        };
        // Stop first: only then has the stderr reader consumed everything the
        // child wrote before exit. Building the caller-facing reason earlier
        // raced the stdout thread and intermittently lost the useful detail.
        let stderr = server.transport.stop();
        if let Some(failure) = failure {
            let failure = append_stderr_reason(failure.to_string(), stderr);
            for (_, pending) in server.pending.drain() {
                let _ = pending.reply.send(Err(failure.clone()));
            }
            for queued in server.queued.drain(..) {
                let _ = queued.reply.send(Err(failure.clone()));
            }
        }
    }
}

fn response_result(message: &Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        let code = error
            .get("code")
            .map(Value::to_string)
            .unwrap_or_else(|| "unknown".into());
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("codex app-server error {code}: {detail}"));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| "codex app-server response carried neither result nor error".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Barrier;

    #[derive(Clone, Copy)]
    enum FakeMode {
        Normal,
        InitializeDelayed,
        ReverseTwo,
        CrashFirst,
        InitializeSilent,
        RequestSilent,
        RpcError,
        MissingResult,
        WriteFailure,
    }

    struct FakeLauncher {
        mode: FakeMode,
        starts: Arc<AtomicUsize>,
        stops: Arc<AtomicUsize>,
        crashed: Arc<AtomicBool>,
    }

    impl ServerLauncher for FakeLauncher {
        fn start(
            &self,
            generation: u64,
            events: Sender<WorkerCommand>,
        ) -> Result<Box<dyn ServerTransport>, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeTransport {
                mode: self.mode,
                generation,
                events,
                stops: Arc::clone(&self.stops),
                crashed: Arc::clone(&self.crashed),
                reversed: Vec::new(),
                stopped: false,
            }))
        }
    }

    struct FakeTransport {
        mode: FakeMode,
        generation: u64,
        events: Sender<WorkerCommand>,
        stops: Arc<AtomicUsize>,
        crashed: Arc<AtomicBool>,
        reversed: Vec<Value>,
        stopped: bool,
    }

    impl FakeTransport {
        fn respond(&self, request: &Value) {
            let id = request["id"].clone();
            let result = request
                .get("params")
                .cloned()
                .unwrap_or_else(|| json!({ "rateLimits": { "primary": null } }));
            let _ = self.events.send(WorkerCommand::ServerMessage {
                generation: self.generation,
                message: json!({ "id": id, "result": result }),
            });
        }
    }

    impl ServerTransport for FakeTransport {
        fn send(&mut self, message: &Value) -> Result<(), String> {
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") if matches!(self.mode, FakeMode::InitializeSilent) => {}
                Some("initialize") if matches!(self.mode, FakeMode::InitializeDelayed) => {
                    thread::sleep(Duration::from_millis(50));
                    self.respond(message);
                }
                Some("initialize") => self.respond(message),
                Some("initialized") => {}
                Some("account/rateLimits/read") | Some("echo") => match self.mode {
                    FakeMode::Normal | FakeMode::InitializeDelayed => self.respond(message),
                    FakeMode::CrashFirst if !self.crashed.swap(true, Ordering::SeqCst) => {
                        let _ = self.events.send(WorkerCommand::ServerClosed {
                            generation: self.generation,
                            reason: "fixture crashed".into(),
                        });
                    }
                    FakeMode::CrashFirst => self.respond(message),
                    FakeMode::ReverseTwo => {
                        self.reversed.push(message.clone());
                        if self.reversed.len() == 2 {
                            self.respond(&self.reversed[1]);
                            self.respond(&self.reversed[0]);
                            self.reversed.clear();
                        }
                    }
                    FakeMode::RequestSilent | FakeMode::InitializeSilent => {}
                    FakeMode::RpcError => {
                        let _ = self.events.send(WorkerCommand::ServerMessage {
                            generation: self.generation,
                            message: json!({
                                "id": message["id"].clone(),
                                "error": { "code": -32601, "message": "fixture rpc error" }
                            }),
                        });
                    }
                    FakeMode::MissingResult => {
                        let _ = self.events.send(WorkerCommand::ServerMessage {
                            generation: self.generation,
                            message: json!({ "id": message["id"].clone() }),
                        });
                    }
                    FakeMode::WriteFailure => return Err("fixture write failed".into()),
                },
                _ => {}
            }
            Ok(())
        }

        fn stop(&mut self) -> Option<String> {
            if !self.stopped {
                self.stopped = true;
                self.stops.fetch_add(1, Ordering::SeqCst);
            }
            None
        }
    }

    impl Drop for FakeTransport {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn fake_manager(
        mode: FakeMode,
        idle_timeout: Duration,
    ) -> (CodexAppServerManager, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        fake_manager_with_timeouts(
            mode,
            idle_timeout,
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
    }

    fn fake_manager_with_timeouts(
        mode: FakeMode,
        idle_timeout: Duration,
        startup_timeout: Duration,
        request_timeout: Duration,
    ) -> (CodexAppServerManager, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let starts = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let manager = CodexAppServerManager::new(WorkerConfig {
            launcher: Arc::new(FakeLauncher {
                mode,
                starts: Arc::clone(&starts),
                stops: Arc::clone(&stops),
                crashed: Arc::new(AtomicBool::new(false)),
            }),
            idle_timeout,
            startup_timeout,
            request_timeout,
        });
        (manager, starts, stops)
    }

    #[test]
    fn starts_lazily_initializes_once_and_reuses_the_child() {
        let (manager, starts, _) = fake_manager(FakeMode::Normal, Duration::from_secs(10));
        assert_eq!(
            starts.load(Ordering::SeqCst),
            0,
            "manager construction is lazy"
        );

        assert!(manager
            .read_rate_limits()
            .unwrap()
            .body
            .contains("rateLimits"));
        assert!(manager
            .read_rate_limits()
            .unwrap()
            .body
            .contains("rateLimits"));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn response_source_time_is_captured_after_cold_initialization() {
        let (manager, _, _) = fake_manager(FakeMode::InitializeDelayed, Duration::from_secs(10));
        let web_trigger_at = unix_time_ms();

        let read = manager.read_rate_limits().unwrap();

        assert!(
            read.source_at.saturating_sub(web_trigger_at) >= 30,
            "sourceAt={} trigger={web_trigger_at}",
            read.source_at
        );
    }

    #[test]
    fn routes_concurrent_out_of_order_responses_by_id() {
        let (manager, starts, _) = fake_manager(FakeMode::ReverseTwo, Duration::from_secs(10));
        let barrier = Arc::new(Barrier::new(3));
        let run = |tag: &'static str| {
            let manager = manager.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                manager.request("echo", Some(json!({ "tag": tag })))
            })
        };
        let a = run("a");
        let b = run("b");
        barrier.wait();

        let mut tags = vec![
            a.join().unwrap().unwrap().result["tag"]
                .as_str()
                .unwrap()
                .to_string(),
            b.join().unwrap().unwrap().result["tag"]
                .as_str()
                .unwrap()
                .to_string(),
        ];
        tags.sort();
        assert_eq!(tags, vec!["a", "b"]);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn idle_child_is_reaped_and_the_next_request_starts_a_new_generation() {
        let starts = Arc::new(AtomicUsize::new(1));
        let stops = Arc::new(AtomicUsize::new(0));
        let crashed = Arc::new(AtomicBool::new(false));
        let (events, commands) = mpsc::channel();
        let idle_timeout = Duration::from_millis(30);
        let mut worker = Worker::new(
            WorkerConfig {
                launcher: Arc::new(FakeLauncher {
                    mode: FakeMode::Normal,
                    starts: Arc::clone(&starts),
                    stops: Arc::clone(&stops),
                    crashed: Arc::clone(&crashed),
                }),
                idle_timeout,
                startup_timeout: Duration::from_secs(1),
                request_timeout: Duration::from_secs(1),
            },
            commands,
            events.clone(),
        );
        worker.next_generation = 2;
        worker.server = Some(RunningServer {
            generation: 1,
            transport: Box::new(FakeTransport {
                mode: FakeMode::Normal,
                generation: 1,
                events,
                stops: Arc::clone(&stops),
                crashed,
                reversed: Vec::new(),
                stopped: false,
            }),
            phase: ServerPhase::Ready,
            queued: VecDeque::new(),
            pending: HashMap::new(),
            next_request_id: 2,
            last_activity: Instant::now() - idle_timeout,
        });

        let (reply, _response) = mpsc::sync_channel(1);
        worker.handle_request(ClientRequest {
            method: "account/rateLimits/read".into(),
            params: None,
            reply,
        });

        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert_eq!(
            worker.server.as_ref().map(|server| server.generation),
            Some(2)
        );
    }

    #[test]
    fn a_crash_fails_pending_work_and_later_demand_restarts() {
        let (manager, starts, _) = fake_manager(FakeMode::CrashFirst, Duration::from_secs(10));
        assert_eq!(manager.read_rate_limits().unwrap_err(), "fixture crashed");
        assert!(manager
            .read_rate_limits()
            .unwrap()
            .body
            .contains("rateLimits"));
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn initialization_timeout_fails_every_queued_request_and_restarts_later() {
        let (manager, starts, _) = fake_manager_with_timeouts(
            FakeMode::InitializeSilent,
            Duration::from_secs(10),
            Duration::from_millis(30),
            Duration::from_millis(30),
        );
        let first = {
            let manager = manager.clone();
            thread::spawn(move || manager.read_rate_limits())
        };
        let second = {
            let manager = manager.clone();
            thread::spawn(move || manager.read_rate_limits())
        };
        for result in [first.join().unwrap(), second.join().unwrap()] {
            assert_eq!(
                result.unwrap_err(),
                "codex app-server initialization timed out"
            );
        }

        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "codex app-server initialization timed out"
        );
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn request_timeout_fails_pending_work_and_reaps_the_generation() {
        let (manager, starts, stops) = fake_manager_with_timeouts(
            FakeMode::RequestSilent,
            Duration::from_secs(10),
            Duration::from_millis(30),
            Duration::from_millis(30),
        );
        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "codex app-server request timed out"
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn protocol_errors_are_returned_without_poisoning_the_ready_server() {
        let (manager, starts, _) = fake_manager(FakeMode::RpcError, Duration::from_secs(10));
        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "codex app-server error -32601: fixture rpc error"
        );
        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "codex app-server error -32601: fixture rpc error"
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_response_without_result_or_error_is_rejected() {
        let (manager, _, _) = fake_manager(FakeMode::MissingResult, Duration::from_secs(10));
        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "codex app-server response carried neither result nor error"
        );
    }

    #[test]
    fn a_request_write_failure_reaps_the_generation_and_restarts_on_demand() {
        let (manager, starts, stops) =
            fake_manager(FakeMode::WriteFailure, Duration::from_secs(10));
        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "fixture write failed"
        );
        assert_eq!(
            manager.read_rate_limits().unwrap_err(),
            "fixture write failed"
        );
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(stops.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stderr_diagnostics_keep_only_the_bounded_tail() {
        let tail: StderrTail = Arc::new(Mutex::new(Vec::new()));
        append_stderr(&tail, &vec![b'a'; MAX_STDERR_BYTES]);
        append_stderr(&tail, b"useful-tail");

        let kept = tail.lock().unwrap();
        assert_eq!(kept.len(), MAX_STDERR_BYTES);
        assert!(kept.ends_with(b"useful-tail"));
    }

    #[cfg(unix)]
    #[test]
    fn stdio_transport_round_trips_the_real_jsonl_protocol() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex");
        fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"platformFamily":"unix"}}' ;;
    *'"method":"account/rateLimits/read"'*) printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":51,"windowDurationMins":10080,"resetsAt":1785004593},"secondary":null}}}' ;;
  esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();

        let command = codex_command(dir.path().as_os_str());
        assert_eq!(command.program, script.as_os_str());
        assert_eq!(
            command.env,
            vec![(
                OsString::from("PATH"),
                dir.path().as_os_str().to_os_string()
            )]
        );

        let manager = CodexAppServerManager::new(WorkerConfig {
            launcher: Arc::new(StdioLauncher { command }),
            idle_timeout: Duration::from_secs(10),
            startup_timeout: Duration::from_secs(1),
            request_timeout: Duration::from_secs(1),
        });
        let read = manager.read_rate_limits().unwrap();
        let body: Value = serde_json::from_str(&read.body).unwrap();
        assert_eq!(body["rateLimits"]["primary"]["usedPercent"], 51);
        assert!(read.source_at > 0);
    }

    #[cfg(unix)]
    #[test]
    fn stdio_transport_allows_a_bounded_graceful_eof_shutdown() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex");
        let marker = dir.path().join("graceful.marker");
        fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"account/rateLimits/read"'*) printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":null}}}' ;;
  esac
done
/bin/sleep 0.05
printf '%s' 'clean' > "$KEEPDECK_GRACEFUL_MARKER"
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = codex_command(dir.path().as_os_str());
        command.env.push((
            OsString::from("KEEPDECK_GRACEFUL_MARKER"),
            marker.as_os_str().to_os_string(),
        ));

        let manager = CodexAppServerManager::new(WorkerConfig {
            launcher: Arc::new(StdioLauncher { command }),
            idle_timeout: Duration::from_secs(10),
            startup_timeout: Duration::from_secs(1),
            request_timeout: Duration::from_secs(1),
        });
        manager.read_rate_limits().unwrap();
        drop(manager);

        assert_eq!(fs::read_to_string(marker).unwrap(), "clean");
    }

    #[cfg(unix)]
    #[test]
    fn stdio_failures_include_a_bounded_stderr_tail() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex");
        fs::write(
            &script,
            r#"#!/bin/sh
IFS= read -r _line
printf '%s\n' 'fixture auth detail' >&2
printf '%s\n' 'not-json'
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();

        let manager = CodexAppServerManager::new(WorkerConfig {
            launcher: Arc::new(StdioLauncher {
                command: codex_command(dir.path().as_os_str()),
            }),
            idle_timeout: Duration::from_secs(10),
            startup_timeout: Duration::from_secs(1),
            request_timeout: Duration::from_secs(1),
        });
        let error = manager.read_rate_limits().unwrap_err();
        assert!(error.contains("wrote invalid JSON"), "{error}");
        assert!(error.contains("fixture auth detail"), "{error}");
    }
}
