//! The host harness: the app itself — [`crate::compose`], its state, setup
//! and one list of commands — on Tauri's test runtime, serving the page's
//! tests over a pipe. Built only with the `host-harness` feature, into the
//! `kd-host` binary; never part of a release.
//!
//! The pipe is JSON lines on stdin and stdout:
//! - in: `{"id", "cmd", "args"}` — a command, by the name the page invokes it
//!   by; `{"watch": name}` — forward the app's events of that name;
//! - out: `{"ready": true}` once the app's setup has run; `{"id", "ok"}` or
//!   `{"id", "error"}` per command; `{"channel", "index", "message"}` per
//!   message of any channel a command was handed; `{"event", "payload"}` per
//!   watched event.
//!
//! Each request enters [`tauri::Webview::on_message`], the same entry a
//! window's IPC takes, so the app's generated command wrappers run as they
//! are — argument names, state, errors — and there is no second list of
//! commands. When the pipe closes, the host stops its sessions and exits.

use crate::session_machine::SessionMachine;
use serde_json::{json, Value};
use std::io::BufRead;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Listener, Manager};

/// The host's own log, to stderr — where a test's tape picks it up.
struct Stderr;

impl log::Log for Stderr {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{} {}] {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOG: Stderr = Stderr;

fn say(line: Value) {
    println!("{line}");
}

/// A response's body as the page would read it. No command answers with
/// raw bytes; one that does is said, not lost.
fn body(body: &InvokeResponseBody) -> Result<Value, String> {
    match body {
        InvokeResponseBody::Json(text) => serde_json::from_str(text).map_err(|e| format!("a response that is not JSON: {e}")),
        InvokeResponseBody::Raw(bytes) => Err(format!("a raw response of {} bytes: the pipe carries JSON", bytes.len())),
    }
}

/// Serve the app over the pipe until it closes.
pub fn serve() {
    // The app's home must be the test's: a host on a real one would read and
    // write the person's own deck, journal and stores.
    let Some(home) = std::env::var_os("KEEPDECK_HOME") else {
        eprintln!("kd-host: KEEPDECK_HOME must name the test's own home");
        std::process::exit(2);
    };
    // The app's own door: one copy per home, here as in the app — said on
    // stderr, with no dialog.
    let claim = match crate::single::enter(std::path::Path::new(&home)) {
        crate::single::Copy::This { claim } => claim,
        crate::single::Copy::Refused { holder, way } => {
            let pid = holder.map_or_else(|| "a copy that does not name itself".to_owned(), |holder| format!("pid {}", holder.pid));
            eprintln!("kd-host: the home is held by another copy ({pid}): {way:?}");
            std::process::exit(3);
        }
        crate::single::Copy::Fault(fault) => {
            eprintln!("kd-host: the home cannot be owned: {fault}");
            std::process::exit(4);
        }
    };
    if log::set_logger(&LOG).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let app = crate::compose(mock_builder(), |_| Ok(()), claim)
        .channel_interceptor(|_webview, callback, index, message| {
            match body(message) {
                Ok(message) => say(json!({ "channel": callback.0, "index": index, "message": message })),
                Err(error) => say(json!({ "channel": callback.0, "index": index, "fault": error })),
            }
            true
        })
        .build(mock_context(noop_assets()))
        .expect("the app builds on the test runtime");
    // The app's setup runs once the runtime is ready, inside its loop — so
    // the loop runs on this thread, as in the app, and the pipe beside it.
    let handle = app.handle().clone();
    let (ready, when_ready) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        if when_ready.recv().is_err() {
            return;
        }
        let webview = tauri::WebviewWindowBuilder::new(&handle, "main", Default::default()).build().expect("the page's webview");
        say(json!({ "ready": true }));
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let request: Value = match serde_json::from_str(&line) {
                Ok(request) => request,
                Err(e) => {
                    say(json!({ "fault": format!("a request that is not JSON: {e}") }));
                    continue;
                }
            };
            if let Some(name) = request.get("watch").and_then(Value::as_str) {
                let event = name.to_owned();
                handle.listen_any(name, move |heard| {
                    let payload = serde_json::from_str::<Value>(heard.payload()).unwrap_or(Value::Null);
                    say(json!({ "event": event, "payload": payload }));
                });
                continue;
            }
            let id = request["id"].clone();
            let invoke = InvokeRequest {
                cmd: request["cmd"].as_str().unwrap_or_default().to_owned(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("the page's url"),
                body: InvokeBody::Json(request["args"].clone()),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            };
            webview.as_ref().clone().on_message(
                invoke,
                Box::new(move |_webview, _cmd, response, _callback, _error| match response {
                    InvokeResponse::Ok(answer) => match body(&answer) {
                        Ok(ok) => say(json!({ "id": id, "ok": ok })),
                        Err(error) => say(json!({ "id": id, "error": error })),
                    },
                    InvokeResponse::Err(error) => say(json!({ "id": id, "error": error.0 })),
                }),
            );
        }
        // The pipe closed: the test is over, and its agents go with it. The
        // process ends itself — the test runtime has no exit to ask for —
        // between two lines: a line another thread is saying holds stdout
        // until it is whole, and none starts after.
        handle.state::<SessionMachine>().table.shutdown(keepdeck_pty::STOP_GRACE);
        let _between_lines = std::io::stdout().lock();
        std::process::exit(0);
    });
    app.run(move |_app, event| {
        if let tauri::RunEvent::Ready = event {
            let _ = ready.send(());
        }
    });
}
