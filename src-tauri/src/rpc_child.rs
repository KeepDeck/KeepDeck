//! Host-owned JSON-RPC children for plugins.
//!
//! A plugin may need a long-lived helper process that speaks newline-
//! delimited JSON-RPC 2.0 over stdio — an agent CLI's own server mode, asked
//! for account facts without disturbing a pane. A plugin cannot spawn a
//! process, so it declares the server in its manifest (`exec.servers`) and
//! the host keeps it: one lazily started child per (plugin, server), the
//! declared handshake performed by the host once per child generation,
//! responses routed by id, and the child reaped after an idle grace period
//! or when the plugin goes away.
//!
//! A caller cannot exceed the shape it supplies. Only the spec's declared
//! methods cross; the handshake is the host's; a request the server sends
//! the client is refused; results go back opaque. Binding that shape to the
//! plugin's manifest is the plugin gate's job (src/plugins/capabilities/
//! gate.ts) — this module keeps no manifest store, exactly as `downloads`
//! takes its allowed domains and `fsWrite` its roots as arguments.

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

use crate::exec_once::refuse_command;

const IDLE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_STDERR_BYTES: usize = 32 * 1024;
/// One message is one line; a line past this fails the child's generation.
const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Requests one child holds at once, queued and pending together.
const MAX_IN_FLIGHT: usize = 16;
/// Children the host keeps at once, across every plugin.
const MAX_CHILDREN: usize = 8;

/// A server as the plugin's manifest declares it (`exec.servers[]`).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcServerSpec {
    id: String,
    command: String,
    args: Vec<String>,
    handshake: Option<Handshake>,
    methods: Vec<String>,
}

/// Run once per child generation, by the host: request `method`, then send
/// the notification `then`.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    method: String,
    params: Option<Value>,
    then: Option<String>,
}

impl RpcServerSpec {
    /// What a failure names: the command line, never a plugin's own words.
    fn label(&self) -> String {
        std::iter::once(self.command.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// A method this spec lets a caller send, refused before any child
    /// starts.
    fn admit(&self, method: &str) -> Result<(), String> {
        if let Some(why) = refuse_command(&self.command) {
            return Err(format!("refused: {why}"));
        }
        if let Some(handshake) = &self.handshake {
            if handshake.method == method || handshake.then.as_deref() == Some(method) {
                return Err(format!("refused: {method} is the host's handshake"));
            }
        }
        if !self.methods.iter().any(|declared| declared == method) {
            return Err(format!("refused: {method} is not a declared method of {}", self.id));
        }
        Ok(())
    }
}

/// The result of one call: the JSON-RPC `result`, serialized and opaque,
/// and the instant just before the request was written — after any cold
/// start and handshake, so it is the earliest the server could have looked.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcAnswer {
    result: String,
    sent_at: u64,
}

/// Every plugin's children, keyed by (plugin, server). Tauri managed state;
/// dropping it stops them all.
pub struct RpcChildPool {
    children: Mutex<HashMap<(String, String), PoolEntry>>,
    configure: Arc<dyn Fn(&RpcServerSpec) -> WorkerConfig + Send + Sync>,
}

struct PoolEntry {
    spec: RpcServerSpec,
    child: RpcChild,
}

impl Default for RpcChildPool {
    fn default() -> Self {
        Self::new(Arc::new(WorkerConfig::production))
    }
}

impl RpcChildPool {
    fn new(configure: Arc<dyn Fn(&RpcServerSpec) -> WorkerConfig + Send + Sync>) -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            configure,
        }
    }

    fn request(
        &self,
        plugin: &str,
        spec: &RpcServerSpec,
        method: &str,
        params: Option<Value>,
    ) -> Result<RpcAnswer, String> {
        spec.admit(method)?;
        let child = self.child(plugin, spec)?;
        let response = child.request(method, params)?;
        let result = serde_json::to_string(&response.result)
            .map_err(|error| format!("{} result was not serializable: {error}", spec.label()))?;
        Ok(RpcAnswer {
            result,
            sent_at: response.sent_at,
        })
    }

    /// This plugin's child for `spec`, started on first use. A spec that
    /// changed (a plugin update) replaces the child it had.
    fn child(&self, plugin: &str, spec: &RpcServerSpec) -> Result<RpcChild, String> {
        let key = (plugin.to_string(), spec.id.clone());
        let mut retired = None;
        let child = {
            let mut children = self.children.lock().map_err(|_| "rpc pool poisoned")?;
            if children.get(&key).is_some_and(|entry| entry.spec != *spec) {
                retired = children.remove(&key);
            }
            match children.get(&key) {
                Some(entry) => entry.child.clone(),
                None => {
                    if children.len() >= MAX_CHILDREN {
                        return Err(format!(
                            "refused: the host already keeps {MAX_CHILDREN} rpc servers"
                        ));
                    }
                    let child = RpcChild::new((self.configure)(spec));
                    children.insert(
                        key,
                        PoolEntry {
                            spec: spec.clone(),
                            child: child.clone(),
                        },
                    );
                    child
                }
            }
        };
        // Outside the lock: stopping a child waits for it to exit.
        drop(retired);
        Ok(child)
    }

    /// Stop every child this plugin has — it was deactivated, disabled or
    /// uninstalled.
    fn stop(&self, plugin: &str) {
        let stopped: Vec<PoolEntry> = match self.children.lock() {
            Ok(mut children) => {
                let keys: Vec<_> = children
                    .keys()
                    .filter(|(owner, _)| owner == plugin)
                    .cloned()
                    .collect();
                keys.iter().filter_map(|key| children.remove(key)).collect()
            }
            Err(_) => Vec::new(),
        };
        // Outside the lock, as above.
        drop(stopped);
    }
}

/// Call a method of a server the plugin declared. The gate has already
/// bound `server` to the plugin's manifest; this side holds the call to it.
#[tauri::command(async)]
pub async fn plugin_rpc_request(
    pool: State<'_, Arc<RpcChildPool>>,
    plugin_id: String,
    server: RpcServerSpec,
    method: String,
    params: Option<Value>,
) -> Result<RpcAnswer, String> {
    let pool = Arc::clone(&pool);
    tauri::async_runtime::spawn_blocking(move || pool.request(&plugin_id, &server, &method, params))
        .await
        .map_err(|error| format!("rpc request task failed: {error}"))?
}

/// Stop every child of a plugin that went away.
#[tauri::command(async)]
pub async fn plugin_rpc_stop(pool: State<'_, Arc<RpcChildPool>>, plugin_id: String) -> Result<(), String> {
    let pool = Arc::clone(&pool);
    tauri::async_runtime::spawn_blocking(move || pool.stop(&plugin_id))
        .await
        .map_err(|error| format!("rpc stop task failed: {error}"))
}

/// One server's worker: a thread owning at most one child at a time.
#[derive(Clone)]
struct RpcChild {
    inner: Arc<ChildInner>,
}

struct ChildInner {
    commands: Sender<WorkerCommand>,
    worker: Mutex<Option<JoinHandle<()>>>,
    response_timeout: Duration,
    label: String,
}

impl Drop for ChildInner {
    fn drop(&mut self) {
        let _ = self.commands.send(WorkerCommand::Shutdown);
        if let Some(worker) = self.worker.lock().ok().and_then(|mut worker| worker.take()) {
            let _ = worker.join();
        }
    }
}

impl RpcChild {
    fn new(config: WorkerConfig) -> Self {
        let response_timeout =
            config.startup_timeout + config.request_timeout + Duration::from_secs(1);
        let label = config.label.clone();
        let (commands, receiver) = mpsc::channel();
        let server_events = commands.clone();
        let worker = thread::Builder::new()
            .name(format!("keepdeck rpc {label}"))
            .spawn(move || Worker::new(config, receiver, server_events).run())
            .expect("rpc worker thread must start");
        Self {
            inner: Arc::new(ChildInner {
                commands,
                worker: Mutex::new(Some(worker)),
                response_timeout,
                label,
            }),
        }
    }

    fn request(&self, method: &str, params: Option<Value>) -> Result<TimedResponse, String> {
        let label = &self.inner.label;
        let (reply, response) = mpsc::sync_channel(1);
        self.inner
            .commands
            .send(WorkerCommand::Request(ClientRequest {
                method: method.to_string(),
                params,
                reply,
            }))
            .map_err(|_| format!("{label} worker stopped"))?;
        response
            .recv_timeout(self.inner.response_timeout)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => format!("{label} worker timed out"),
                RecvTimeoutError::Disconnected => format!("{label} worker stopped"),
            })?
    }
}

struct ClientRequest {
    method: String,
    params: Option<Value>,
    reply: SyncSender<Result<TimedResponse, String>>,
}

#[derive(Debug)]
struct TimedResponse {
    result: Value,
    sent_at: u64,
}

enum WorkerCommand {
    Request(ClientRequest),
    ServerMessage { generation: u64, message: Value },
    ServerClosed { generation: u64, reason: String },
    Shutdown,
}

#[derive(Clone)]
struct WorkerConfig {
    label: String,
    launcher: Arc<dyn ServerLauncher>,
    handshake: Option<Handshake>,
    idle_timeout: Duration,
    startup_timeout: Duration,
    request_timeout: Duration,
}

impl WorkerConfig {
    fn production(spec: &RpcServerSpec) -> Self {
        Self {
            label: spec.label(),
            launcher: Arc::new(StdioLauncher {
                label: spec.label(),
                command: command_spec(spec, keepdeck_env::augmented_path()),
            }),
            handshake: spec.handshake.clone(),
            idle_timeout: IDLE_TIMEOUT,
            startup_timeout: STARTUP_TIMEOUT,
            request_timeout: REQUEST_TIMEOUT,
        }
    }
}

fn command_spec(spec: &RpcServerSpec, path: &OsStr) -> CommandSpec {
    CommandSpec {
        // Match agent detection and pane spawning exactly: a GUI-launched
        // macOS app otherwise sees launchd's stripped PATH and can report a
        // CLI installed while this child still fails to resolve it.
        program: keepdeck_env::resolve_program(&spec.command, path),
        args: spec.args.iter().map(OsString::from).collect(),
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
    label: String,
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

/// One line read with a ceiling: a child that writes a line without end
/// cannot make the host buffer it.
enum CappedLine {
    Line(Vec<u8>),
    TooLong,
    End,
}

fn read_capped_line(reader: &mut impl BufRead, cap: usize) -> std::io::Result<CappedLine> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if line.is_empty() {
                CappedLine::End
            } else {
                CappedLine::Line(line)
            });
        }
        let (taken, done) = match available.iter().position(|&byte| byte == b'\n') {
            Some(at) => (at + 1, true),
            None => (available.len(), false),
        };
        line.extend_from_slice(&available[..taken]);
        reader.consume(taken);
        if line.len() > cap + 1 {
            return Ok(CappedLine::TooLong);
        }
        if done {
            line.pop();
            return Ok(CappedLine::Line(line));
        }
    }
}

/// Forward the child's stdout to the worker, one message per line.
fn pump_stdout(label: &str, stdout: impl Read, generation: u64, events: &Sender<WorkerCommand>) {
    let mut reader = BufReader::new(stdout);
    let closed = |reason: String| {
        let _ = events.send(WorkerCommand::ServerClosed { generation, reason });
    };
    loop {
        let line = match read_capped_line(&mut reader, MAX_LINE_BYTES) {
            Ok(CappedLine::Line(line)) => line,
            Ok(CappedLine::TooLong) => {
                return closed(format!("{label} wrote a line over {MAX_LINE_BYTES} bytes"));
            }
            Ok(CappedLine::End) => return closed(format!("{label} closed its stdout")),
            Err(error) => return closed(format!("{label} stdout failed: {error}")),
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let message = match serde_json::from_slice(&line) {
            Ok(message) => message,
            Err(error) => return closed(format!("{label} wrote invalid JSON: {error}")),
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
}

impl ServerLauncher for StdioLauncher {
    fn start(
        &self,
        generation: u64,
        events: Sender<WorkerCommand>,
    ) -> Result<Box<dyn ServerTransport>, String> {
        let label = self.label.clone();
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
            .map_err(|error| format!("could not start {label}: {error}"))?;
        let kill = |child: &mut Child| {
            let _ = child.kill();
            let _ = child.wait();
        };
        let Some(stdin) = child.stdin.take() else {
            kill(&mut child);
            return Err(format!("{label} opened no stdin"));
        };
        let Some(stdout) = child.stdout.take() else {
            kill(&mut child);
            return Err(format!("{label} opened no stdout"));
        };
        let Some(stderr) = child.stderr.take() else {
            kill(&mut child);
            return Err(format!("{label} opened no stderr"));
        };

        let stderr_tail: StderrTail = Arc::new(Mutex::new(Vec::new()));
        let stderr_sink = Arc::clone(&stderr_tail);
        let stderr_reader = match thread::Builder::new()
            .name(format!("keepdeck rpc {label} stderr"))
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut chunk = [0_u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(read) => append_stderr(&stderr_sink, &chunk[..read]),
                    }
                }
            }) {
            Ok(reader) => reader,
            Err(error) => {
                kill(&mut child);
                return Err(format!("{label} stderr reader failed to start: {error}"));
            }
        };

        let stdout_label = label.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("keepdeck rpc {label} stdout"))
            .spawn(move || pump_stdout(&stdout_label, stdout, generation, &events))
        {
            kill(&mut child);
            let _ = stderr_reader.join();
            return Err(format!("{label} stdout reader failed to start: {error}"));
        }

        Ok(Box::new(StdioTransport {
            label,
            child,
            stdin: Some(stdin),
            stderr_reader: Some(stderr_reader),
            stderr_tail,
        }))
    }
}

struct StdioTransport {
    label: String,
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr_tail: StderrTail,
}

impl ServerTransport for StdioTransport {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let label = &self.label;
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| format!("{label} stdin is closed"))?;
        serde_json::to_writer(&mut *stdin, message)
            .map_err(|error| format!("{label} request encode failed: {error}"))?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("{label} stdin failed: {error}"))
    }

    fn stop(&mut self) -> Option<String> {
        // EOF is a stdio server's clean shutdown. Give it a small, bounded
        // grace period to release its own resources before the hard kill
        // fallback, then always reap it — no zombies.
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
        self.stderr_tail.lock().ok().and_then(|tail| {
            let detail = String::from_utf8_lossy(&tail).trim().to_string();
            (!detail.is_empty()).then_some(detail)
        })
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
    sent_at: u64,
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
                sent_at: unix_time_ms(),
            },
        );
        self.send_raw(message)
    }

    fn in_flight(&self) -> usize {
        self.pending.len() + self.queued.len()
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

    fn stopped(&self) -> String {
        format!("{} worker stopped", self.config.label)
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
                let stopped = self.stopped();
                self.stop_server(Some(&stopped));
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
                    let stopped = self.stopped();
                    self.stop_server(Some(&stopped));
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
        if self
            .server
            .as_ref()
            .is_some_and(|server| server.in_flight() >= MAX_IN_FLIGHT)
        {
            let _ = request.reply.send(Err(format!(
                "{} is busy: {MAX_IN_FLIGHT} requests already in flight",
                self.config.label
            )));
            return;
        }
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
        let handshake_id = 1;
        let mut server = RunningServer {
            generation,
            transport,
            phase: ServerPhase::Ready,
            queued: VecDeque::new(),
            pending: HashMap::new(),
            next_request_id: handshake_id + 1,
            last_activity: now,
        };
        if let Some(handshake) = &self.config.handshake {
            let mut message = json!({ "method": handshake.method, "id": handshake_id });
            if let Some(params) = &handshake.params {
                message["params"] = params.clone();
            }
            if let Err(error) = server.send_raw(message) {
                let stderr = server.transport.stop();
                return Err(append_stderr_reason(error, stderr));
            }
            server.phase = ServerPhase::Initializing {
                request_id: handshake_id,
                deadline: now + self.config.startup_timeout,
            };
        }
        self.server = Some(server);
        Ok(())
    }

    fn handle_server_message(&mut self, generation: u64, message: Value) {
        if self.server.as_ref().map(|server| server.generation) != Some(generation) {
            return; // late output from a reaped generation
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            // A message with a method is the server speaking first: a
            // notification, or a request to the client. The host answers no
            // requests — a server request whose id equals one of ours must
            // not be taken for our answer.
            match message.get("id") {
                Some(id) => {
                    let refusal = json!({
                        "id": id,
                        "error": { "code": -32601, "message": "client handles no requests" }
                    });
                    if let Err(error) = self.server.as_mut().expect("generation checked above").send_raw(refusal) {
                        self.stop_server(Some(&error));
                    }
                }
                None => log::trace!("{} notification: {method}", self.config.label),
            }
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return;
        };

        let handshaking = matches!(
            self.server.as_ref().map(|server| &server.phase),
            Some(ServerPhase::Initializing { request_id, .. }) if *request_id == id
        );
        if handshaking {
            self.finish_handshake(&message);
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
            let response = response_result(&self.config.label, &message).map(|result| TimedResponse {
                result,
                sent_at: pending.sent_at,
            });
            let _ = pending.reply.send(response);
        }
    }

    fn finish_handshake(&mut self, message: &Value) {
        if let Err(error) = response_result(&self.config.label, message) {
            let failure = format!("{} handshake failed: {error}", self.config.label);
            self.stop_server(Some(&failure));
            return;
        }
        let then = self.config.handshake.as_ref().and_then(|handshake| handshake.then.clone());
        let server = self.server.as_mut().expect("generation checked by the caller");
        if let Some(then) = then {
            if let Err(error) = server.send_raw(json!({ "method": then, "params": {} })) {
                self.stop_server(Some(&error));
                return;
            }
        }
        server.phase = ServerPhase::Ready;
        server.last_activity = Instant::now();
        self.flush_queued();
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
                Some(format!("{} handshake timed out", self.config.label))
            }
            _ if server
                .pending
                .values()
                .any(|pending| now >= pending.deadline) =>
            {
                Some(format!("{} request timed out", self.config.label))
            }
            _ => None,
        };
        if let Some(failure) = failure {
            self.stop_server(Some(&failure));
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

fn response_result(label: &str, message: &Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        let code = error
            .get("code")
            .map(Value::to_string)
            .unwrap_or_else(|| "unknown".into());
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("{label} error {code}: {detail}"));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{label} response carried neither result nor error"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Barrier;

    #[derive(Clone, Copy)]
    enum FakeMode {
        Normal,
        HandshakeDelayed,
        ReverseTwo,
        CrashFirst,
        HandshakeSilent,
        RequestSilent,
        RpcError,
        MissingResult,
        WriteFailure,
        /// Before answering, the server sends the client a request that
        /// carries the SAME id as the call it is answering.
        ServerRequestFirst,
    }

    #[derive(Default)]
    struct Counters {
        starts: AtomicUsize,
        stops: AtomicUsize,
        crashed: AtomicBool,
        /// Every message the host wrote, in order, across generations.
        written: Mutex<Vec<Value>>,
    }

    struct FakeLauncher {
        mode: FakeMode,
        counters: Arc<Counters>,
    }

    impl ServerLauncher for FakeLauncher {
        fn start(
            &self,
            generation: u64,
            events: Sender<WorkerCommand>,
        ) -> Result<Box<dyn ServerTransport>, String> {
            self.counters.starts.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeTransport {
                mode: self.mode,
                generation,
                events,
                counters: Arc::clone(&self.counters),
                reversed: Vec::new(),
                stopped: false,
            }))
        }
    }

    struct FakeTransport {
        mode: FakeMode,
        generation: u64,
        events: Sender<WorkerCommand>,
        counters: Arc<Counters>,
        reversed: Vec<Value>,
        stopped: bool,
    }

    impl FakeTransport {
        fn emit(&self, message: Value) {
            let _ = self.events.send(WorkerCommand::ServerMessage {
                generation: self.generation,
                message,
            });
        }

        fn respond(&self, request: &Value) {
            let result = request
                .get("params")
                .cloned()
                .unwrap_or_else(|| json!({ "answered": request["method"].clone() }));
            self.emit(json!({ "id": request["id"].clone(), "result": result }));
        }
    }

    impl ServerTransport for FakeTransport {
        fn send(&mut self, message: &Value) -> Result<(), String> {
            self.counters.written.lock().unwrap().push(message.clone());
            match message.get("method").and_then(Value::as_str) {
                None => {}
                Some("initialize") if matches!(self.mode, FakeMode::HandshakeSilent) => {}
                Some("initialize") if matches!(self.mode, FakeMode::HandshakeDelayed) => {
                    thread::sleep(Duration::from_millis(50));
                    self.respond(message);
                }
                Some("initialize") => self.respond(message),
                Some("initialized") => {}
                Some(_) => match self.mode {
                    FakeMode::Normal | FakeMode::HandshakeDelayed => self.respond(message),
                    FakeMode::CrashFirst if !self.counters.crashed.swap(true, Ordering::SeqCst) => {
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
                    FakeMode::RequestSilent | FakeMode::HandshakeSilent => {}
                    FakeMode::RpcError => self.emit(json!({
                        "id": message["id"].clone(),
                        "error": { "code": -32601, "message": "fixture rpc error" }
                    })),
                    FakeMode::MissingResult => self.emit(json!({ "id": message["id"].clone() })),
                    FakeMode::WriteFailure => return Err("fixture write failed".into()),
                    FakeMode::ServerRequestFirst => {
                        self.emit(json!({
                            "id": message["id"].clone(),
                            "method": "item/approve",
                            "params": { "trap": true }
                        }));
                        self.respond(message);
                    }
                },
            }
            Ok(())
        }

        fn stop(&mut self) -> Option<String> {
            if !self.stopped {
                self.stopped = true;
                self.counters.stops.fetch_add(1, Ordering::SeqCst);
            }
            None
        }
    }

    impl Drop for FakeTransport {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn handshake() -> Handshake {
        Handshake {
            method: "initialize".into(),
            params: Some(json!({ "clientInfo": { "name": "keepdeck" } })),
            then: Some("initialized".into()),
        }
    }

    fn spec(args: &[&str]) -> RpcServerSpec {
        RpcServerSpec {
            id: "server".into(),
            command: "fixture".into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            handshake: Some(handshake()),
            methods: vec!["read".into(), "echo".into()],
        }
    }

    fn fake_config(
        mode: FakeMode,
        counters: &Arc<Counters>,
        idle_timeout: Duration,
        startup_timeout: Duration,
        request_timeout: Duration,
    ) -> WorkerConfig {
        WorkerConfig {
            label: "fixture server".into(),
            launcher: Arc::new(FakeLauncher {
                mode,
                counters: Arc::clone(counters),
            }),
            handshake: Some(handshake()),
            idle_timeout,
            startup_timeout,
            request_timeout,
        }
    }

    fn fake_child(mode: FakeMode) -> (RpcChild, Arc<Counters>) {
        fake_child_with_timeouts(mode, Duration::from_secs(1), Duration::from_secs(1))
    }

    fn fake_child_with_timeouts(
        mode: FakeMode,
        startup_timeout: Duration,
        request_timeout: Duration,
    ) -> (RpcChild, Arc<Counters>) {
        let counters = Arc::new(Counters::default());
        let child = RpcChild::new(fake_config(
            mode,
            &counters,
            Duration::from_secs(10),
            startup_timeout,
            request_timeout,
        ));
        (child, counters)
    }

    fn fake_pool(mode: FakeMode) -> (RpcChildPool, Arc<Counters>) {
        let counters = Arc::new(Counters::default());
        let shared = Arc::clone(&counters);
        let pool = RpcChildPool::new(Arc::new(move |_spec: &RpcServerSpec| {
            fake_config(
                mode,
                &shared,
                Duration::from_secs(10),
                Duration::from_secs(1),
                Duration::from_secs(1),
            )
        }));
        (pool, counters)
    }

    fn methods_written(counters: &Counters) -> Vec<String> {
        counters
            .written
            .lock()
            .unwrap()
            .iter()
            .filter_map(|message| message["method"].as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn starts_lazily_handshakes_once_and_reuses_the_child() {
        let (child, counters) = fake_child(FakeMode::Normal);
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0, "construction is lazy");

        assert_eq!(child.request("read", None).unwrap().result["answered"], "read");
        assert_eq!(child.request("read", None).unwrap().result["answered"], "read");
        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
        assert_eq!(
            methods_written(&counters),
            vec!["initialize", "initialized", "read", "read"]
        );
    }

    #[test]
    fn a_server_without_a_handshake_is_ready_at_once() {
        let counters = Arc::new(Counters::default());
        let mut config = fake_config(
            FakeMode::Normal,
            &counters,
            Duration::from_secs(10),
            Duration::from_secs(1),
            Duration::from_secs(1),
        );
        config.handshake = None;
        let child = RpcChild::new(config);
        child.request("read", None).unwrap();
        assert_eq!(methods_written(&counters), vec!["read"]);
    }

    #[test]
    fn sent_at_is_captured_after_a_cold_handshake() {
        let (child, _) = fake_child(FakeMode::HandshakeDelayed);
        let web_trigger_at = unix_time_ms();

        let read = child.request("read", None).unwrap();

        assert!(
            read.sent_at.saturating_sub(web_trigger_at) >= 30,
            "sentAt={} trigger={web_trigger_at}",
            read.sent_at
        );
    }

    #[test]
    fn routes_concurrent_out_of_order_responses_by_id() {
        let (child, counters) = fake_child(FakeMode::ReverseTwo);
        let barrier = Arc::new(Barrier::new(3));
        let run = |tag: &'static str| {
            let child = child.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                child.request("echo", Some(json!({ "tag": tag })))
            })
        };
        let a = run("a");
        let b = run("b");
        barrier.wait();

        let mut tags = vec![
            a.join().unwrap().unwrap().result["tag"].as_str().unwrap().to_string(),
            b.join().unwrap().unwrap().result["tag"].as_str().unwrap().to_string(),
        ];
        tags.sort();
        assert_eq!(tags, vec!["a", "b"]);
        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_server_request_with_our_id_is_refused_and_does_not_resolve_our_call() {
        let (child, counters) = fake_child(FakeMode::ServerRequestFirst);

        let answer = child.request("echo", Some(json!({ "tag": "ours" }))).unwrap();

        assert_eq!(answer.result["tag"], "ours");
        let written = counters.written.lock().unwrap();
        let refusal = written
            .iter()
            .find(|message| message.get("error").is_some())
            .expect("the server's request is answered");
        assert_eq!(refusal["error"]["code"], -32601);
        assert_eq!(refusal["id"], written.iter().find(|m| m["method"] == "echo").unwrap()["id"]);
    }

    /// A worker holding a ready server, for tests that need its state set
    /// exactly rather than reached through timing.
    fn worker_with_ready_server(
        counters: &Arc<Counters>,
        idle_timeout: Duration,
        last_activity: Instant,
    ) -> Worker {
        let (events, commands) = mpsc::channel();
        let mut worker = Worker::new(
            fake_config(
                FakeMode::RequestSilent,
                counters,
                idle_timeout,
                Duration::from_secs(1),
                Duration::from_secs(1),
            ),
            commands,
            events.clone(),
        );
        worker.next_generation = 2;
        worker.server = Some(RunningServer {
            generation: 1,
            transport: Box::new(FakeTransport {
                mode: FakeMode::RequestSilent,
                generation: 1,
                events,
                counters: Arc::clone(counters),
                reversed: Vec::new(),
                stopped: false,
            }),
            phase: ServerPhase::Ready,
            queued: VecDeque::new(),
            pending: HashMap::new(),
            next_request_id: 2,
            last_activity,
        });
        worker
    }

    fn client_request() -> (ClientRequest, Receiver<Result<TimedResponse, String>>) {
        let (reply, response) = mpsc::sync_channel(1);
        (
            ClientRequest {
                method: "read".into(),
                params: None,
                reply,
            },
            response,
        )
    }

    #[test]
    fn idle_child_is_reaped_and_the_next_request_starts_a_new_generation() {
        let counters = Arc::new(Counters::default());
        let idle_timeout = Duration::from_millis(30);
        let mut worker =
            worker_with_ready_server(&counters, idle_timeout, Instant::now() - idle_timeout);

        let (request, _response) = client_request();
        worker.handle_request(request);

        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
        assert_eq!(counters.stops.load(Ordering::SeqCst), 1);
        assert_eq!(worker.server.as_ref().map(|server| server.generation), Some(2));
    }

    #[test]
    fn a_request_past_the_in_flight_limit_is_refused_busy() {
        let counters = Arc::new(Counters::default());
        let mut worker =
            worker_with_ready_server(&counters, Duration::from_secs(10), Instant::now());
        let mut held = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            let (request, response) = client_request();
            worker.handle_request(request);
            held.push(response);
        }
        assert!(held.iter().all(|response| response.try_recv().is_err()), "all sixteen pending");

        let (request, response) = client_request();
        worker.handle_request(request);

        let refused = response.try_recv().unwrap().unwrap_err();
        assert!(refused.contains("busy"), "{refused}");
        assert_eq!(worker.server.as_ref().unwrap().pending.len(), MAX_IN_FLIGHT);
    }

    #[test]
    fn a_crash_fails_pending_work_and_later_demand_restarts() {
        let (child, counters) = fake_child(FakeMode::CrashFirst);
        assert_eq!(child.request("read", None).unwrap_err(), "fixture crashed");
        child.request("read", None).unwrap();
        assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn handshake_timeout_fails_every_queued_request_and_restarts_later() {
        let (child, counters) = fake_child_with_timeouts(
            FakeMode::HandshakeSilent,
            Duration::from_millis(30),
            Duration::from_millis(30),
        );
        let first = {
            let child = child.clone();
            thread::spawn(move || child.request("read", None))
        };
        let second = {
            let child = child.clone();
            thread::spawn(move || child.request("read", None))
        };
        for result in [first.join().unwrap(), second.join().unwrap()] {
            assert_eq!(result.unwrap_err(), "fixture server handshake timed out");
        }

        assert_eq!(
            child.request("read", None).unwrap_err(),
            "fixture server handshake timed out"
        );
        assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn request_timeout_fails_pending_work_and_reaps_the_generation() {
        let (child, counters) = fake_child_with_timeouts(
            FakeMode::RequestSilent,
            Duration::from_millis(30),
            Duration::from_millis(30),
        );
        assert_eq!(
            child.request("read", None).unwrap_err(),
            "fixture server request timed out"
        );
        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
        assert_eq!(counters.stops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn protocol_errors_are_returned_without_poisoning_the_ready_server() {
        let (child, counters) = fake_child(FakeMode::RpcError);
        for _ in 0..2 {
            assert_eq!(
                child.request("read", None).unwrap_err(),
                "fixture server error -32601: fixture rpc error"
            );
        }
        assert_eq!(counters.starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_response_without_result_or_error_is_rejected() {
        let (child, _) = fake_child(FakeMode::MissingResult);
        assert_eq!(
            child.request("read", None).unwrap_err(),
            "fixture server response carried neither result nor error"
        );
    }

    #[test]
    fn a_request_write_failure_reaps_the_generation_and_restarts_on_demand() {
        let (child, counters) = fake_child(FakeMode::WriteFailure);
        for _ in 0..2 {
            assert_eq!(child.request("read", None).unwrap_err(), "fixture write failed");
        }
        assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
        assert_eq!(counters.stops.load(Ordering::SeqCst), 2);
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

    #[test]
    fn a_line_over_the_cap_closes_the_generation_instead_of_buffering_it() {
        let mut stdout = vec![b'x'; MAX_LINE_BYTES + 2];
        stdout.extend_from_slice(b"\n{\"id\":2,\"result\":{}}\n");
        let (events, received) = mpsc::channel();

        pump_stdout("fixture server", Cursor::new(stdout), 7, &events);

        match received.try_recv().unwrap() {
            WorkerCommand::ServerClosed { generation, reason } => {
                assert_eq!(generation, 7);
                assert!(reason.contains("over 1048576 bytes"), "{reason}");
            }
            _ => panic!("expected the generation to close"),
        }
        assert!(received.try_recv().is_err(), "nothing after the long line is read");
    }

    #[test]
    fn a_line_at_the_cap_is_still_a_message() {
        let mut line = br#"{"id":2,"result":""#.to_vec();
        let pad = MAX_LINE_BYTES - line.len() - 2;
        line.extend(std::iter::repeat_n(b'x', pad));
        line.extend_from_slice(b"\"}\n");
        assert_eq!(line.len(), MAX_LINE_BYTES + 1);
        let (events, received) = mpsc::channel();

        pump_stdout("fixture server", Cursor::new(line), 1, &events);

        assert!(matches!(received.try_recv().unwrap(), WorkerCommand::ServerMessage { .. }));
    }

    #[test]
    fn the_pool_refuses_an_undeclared_method_before_starting_anything() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        let error = pool.request("plugin", &spec(&[]), "account/write", None).unwrap_err();
        assert!(error.contains("not a declared method"), "{error}");
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_handshake_is_the_hosts_even_when_declared_as_a_method() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        let mut declared = spec(&[]);
        declared.methods.push("initialize".into());
        declared.methods.push("initialized".into());
        for method in ["initialize", "initialized"] {
            let error = pool.request("plugin", &declared, method, None).unwrap_err();
            assert!(error.contains("handshake"), "{error}");
        }
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_command_must_be_a_name_never_a_path() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        let mut declared = spec(&[]);
        declared.command = "/tmp/fixture".into();
        let error = pool.request("plugin", &declared, "read", None).unwrap_err();
        assert!(error.contains("is a path"), "{error}");
        assert_eq!(counters.starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn each_plugin_gets_its_own_child_and_answers_opaque_json() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        let answer = pool.request("a", &spec(&[]), "echo", Some(json!({ "n": 1 }))).unwrap();
        pool.request("b", &spec(&[]), "echo", None).unwrap();
        pool.request("a", &spec(&[]), "echo", None).unwrap();

        assert_eq!(answer.result, r#"{"n":1}"#);
        assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_changed_spec_replaces_the_child() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        pool.request("a", &spec(&["serve"]), "read", None).unwrap();
        pool.request("a", &spec(&["serve", "--v2"]), "read", None).unwrap();

        assert_eq!(counters.starts.load(Ordering::SeqCst), 2);
        assert_eq!(counters.stops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn stop_reaps_only_that_plugins_children() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        pool.request("a", &spec(&[]), "read", None).unwrap();
        pool.request("b", &spec(&[]), "read", None).unwrap();

        pool.stop("a");

        assert_eq!(counters.stops.load(Ordering::SeqCst), 1);
        pool.request("b", &spec(&[]), "read", None).unwrap();
        assert_eq!(counters.starts.load(Ordering::SeqCst), 2, "b's child kept running");
    }

    #[test]
    fn the_pool_refuses_a_child_past_the_host_wide_limit() {
        let (pool, counters) = fake_pool(FakeMode::Normal);
        for plugin in 0..MAX_CHILDREN {
            pool.request(&plugin.to_string(), &spec(&[]), "read", None).unwrap();
        }
        let error = pool.request("one-more", &spec(&[]), "read", None).unwrap_err();
        assert!(error.contains("already keeps 8"), "{error}");
        assert_eq!(counters.starts.load(Ordering::SeqCst), MAX_CHILDREN);
    }

    /// What a subprocess fixture is allowed to take. Not a behaviour under
    /// test — these spawn a REAL /bin/sh and are about the protocol, not
    /// about latency, so a tight budget would only buy a flake under the
    /// full suite. The timeout tests use the fake launcher instead.
    const STDIO_FIXTURE_TIMEOUT: Duration = Duration::from_secs(15);

    #[cfg(unix)]
    fn stdio_child(dir: &std::path::Path, script: &str, extra_env: &[(&str, &OsStr)]) -> RpcChild {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join("fixture-server");
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let declared = RpcServerSpec {
            id: "server".into(),
            command: "fixture-server".into(),
            args: vec!["serve".into()],
            handshake: Some(handshake()),
            methods: vec!["read".into()],
        };
        let mut command = command_spec(&declared, dir.as_os_str());
        assert_eq!(command.program, path.as_os_str());
        assert_eq!(command.args, vec![OsString::from("serve")]);
        for (name, value) in extra_env {
            command.env.push((OsString::from(name), value.to_os_string()));
        }
        RpcChild::new(WorkerConfig {
            label: declared.label(),
            launcher: Arc::new(StdioLauncher {
                label: declared.label(),
                command,
            }),
            handshake: declared.handshake,
            idle_timeout: Duration::from_secs(10),
            startup_timeout: STDIO_FIXTURE_TIMEOUT,
            request_timeout: STDIO_FIXTURE_TIMEOUT,
        })
    }

    #[cfg(unix)]
    #[test]
    fn stdio_transport_round_trips_the_real_jsonl_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("methods.log");
        let child = stdio_child(
            dir.path(),
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$KEEPDECK_METHOD_LOG"
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"platformFamily":"unix"}}' ;;
    *'"method":"read"'*) printf '%s\n' '{"id":2,"result":{"limits":{"usedPercent":51}}}' ;;
  esac
done
"#,
            &[("KEEPDECK_METHOD_LOG", log.as_os_str())],
        );
        let read = child.request("read", None).unwrap();
        assert_eq!(read.result["limits"]["usedPercent"], 51);
        assert!(read.sent_at > 0);
        drop(child);

        let methods: Vec<String> = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["method"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(methods, vec!["initialize", "initialized", "read"]);
    }

    #[cfg(unix)]
    #[test]
    fn stdio_transport_allows_a_bounded_graceful_eof_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("graceful.marker");
        let child = stdio_child(
            dir.path(),
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"read"'*) printf '%s\n' '{"id":2,"result":{}}' ;;
  esac
done
/bin/sleep 0.05
printf '%s' 'clean' > "$KEEPDECK_GRACEFUL_MARKER"
"#,
            &[("KEEPDECK_GRACEFUL_MARKER", marker.as_os_str())],
        );
        child.request("read", None).unwrap();
        drop(child);

        assert_eq!(std::fs::read_to_string(marker).unwrap(), "clean");
    }

    #[cfg(unix)]
    #[test]
    fn stdio_failures_include_a_bounded_stderr_tail() {
        let dir = tempfile::tempdir().unwrap();
        let child = stdio_child(
            dir.path(),
            r#"#!/bin/sh
IFS= read -r _line
printf '%s\n' 'fixture auth detail' >&2
printf '%s\n' 'not-json'
"#,
            &[],
        );
        let error = child.request("read", None).unwrap_err();
        assert!(error.contains("wrote invalid JSON"), "{error}");
        assert!(error.contains("fixture auth detail"), "{error}");
    }
}
