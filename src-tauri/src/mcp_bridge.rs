//! The socket→webview bridge: MCP requests cross into the webview, where the
//! command registry lives, and the reply crosses back.
//!
//! Why the round-trip: the registry — the deck's single point of command
//! execution — is TypeScript in the webview. Executing in Rust would mean a
//! second command surface; forwarding keeps one executor, one validation,
//! one journal. Each socket line becomes one `deck://mcp/request` event; the
//! per-connection thread parks on a rendezvous channel under a correlation
//! id until the webview answers via `mcp_respond`. A webview that cannot
//! answer (closed, reloading, wedged) turns into a bounded JSON-RPC error
//! instead of a hang.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::mcp_server::LineHandler;

/// Mirrored by `MCP_REQUEST_EVENT` in src/ipc/mcpBridge.ts.
pub const MCP_REQUEST_EVENT: &str = "deck://mcp/request";

/// The transport id notifications cross under: nothing is parked for it,
/// and the webview pump keys "send no reply" on exactly this value.
/// [`McpBridge::begin`] never allocates it — pinned by test.
pub(crate) const NOTIFICATION_ID: u64 = 0;

/// How long a request may wait for the webview. Commands are interactive
/// scale (the slowest, agent.spawn, returns at pane creation, not task
/// delivery), so silence beyond this bound means the webview is gone or
/// wedged — the client then gets an error it can act on, not a dead wait.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpRequest {
    id: u64,
    line: String,
}

/// Managed state: replies in flight, keyed by correlation id.
#[derive(Default)]
pub struct McpBridge {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, SyncSender<String>>>,
}

impl McpBridge {
    /// Park a fresh request slot; the returned receiver rendezvouses with
    /// [`resolve`](Self::resolve).
    fn begin(&self) -> (u64, Receiver<String>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.pending
            .lock()
            .expect("mcp bridge poisoned")
            .insert(id, tx);
        (id, rx)
    }

    /// Deliver the webview's reply. False when the slot is gone — the
    /// request already timed out and answered its client, so a late reply
    /// is dropped rather than delivered twice.
    pub(crate) fn resolve(&self, id: u64, reply: String) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("mcp bridge poisoned")
            .remove(&id);
        match sender {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    fn abandon(&self, id: u64) {
        self.pending.lock().expect("mcp bridge poisoned").remove(&id);
    }
}

/// A JSON-RPC error reply that echoes the request's id when the line parses
/// — a conforming client correlates by id; garbage gets id null. The id
/// rule is [`echoable_id`], the exact mirror of `requestIdOf` in
/// src/domain/mcp/jsonrpc.ts, pinned by tests on the same inputs — chosen
/// to include the inputs the two PARSERS disagree on, not only the easy
/// rejects.
fn error_reply(request_line: &str, code: i64, message: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(request_line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .and_then(echoable_id)
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// A JSON-RPC notification: parses to an object that carries no `id`. Only
/// these forgo a reply — garbage stays a (failed) request, because its
/// sender clearly wanted an answer and silence would cost it the transport
/// timeout. The webview projection derives the same split from the same
/// line, so neither side needs to trust the other's classification.
fn is_notification(line: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(serde_json::Value::Object(map)) => !map.contains_key("id"),
        _ => false,
    }
}

/// The one id rule both sides apply: a string, or an INTEGER-VALUED number
/// within ±(2^53−1) — the range every JSON parser preserves exactly —
/// emitted as an integer. The value test, not the token class: serde keeps
/// `1e2` as a float where JSON.parse yields the integer 100, so filtering
/// on serde's integer types alone made the two sides answer the same
/// request with different ids (round-2 finding).
fn echoable_id(id: serde_json::Value) -> Option<serde_json::Value> {
    const SAFE_MAX: f64 = 9_007_199_254_740_991.0;
    match id {
        serde_json::Value::String(_) => Some(id),
        serde_json::Value::Number(ref n) => n
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() <= SAFE_MAX)
            .map(|f| serde_json::Value::from(f as i64)),
        _ => None,
    }
}

/// The [`LineHandler`] `mcp_enable` wires: one socket line in, one webview
/// event out, and — for requests — one parked wait for the answer.
/// Notifications cross fire-and-forget under the reserved id 0: nothing is
/// parked, so a reply the pump might send anyway lands in `resolve`'s
/// unknown-id drop.
pub(crate) fn webview_handler(app: AppHandle) -> LineHandler {
    Arc::new(move |line: &str| {
        let bridge = app.state::<McpBridge>();
        if is_notification(line) {
            let request = McpRequest {
                id: NOTIFICATION_ID,
                line: line.to_string(),
            };
            if let Err(e) = app.emit(MCP_REQUEST_EVENT, &request) {
                log::warn!("mcp: emitting notification failed: {e}");
            }
            return None;
        }
        let (id, reply) = bridge.begin();
        let request = McpRequest {
            id,
            line: line.to_string(),
        };
        if let Err(e) = app.emit(MCP_REQUEST_EVENT, &request) {
            bridge.abandon(id);
            log::warn!("mcp: emitting request {id} failed: {e}");
            return Some(error_reply(
                line,
                -32603,
                "the deck could not receive the request",
            ));
        }
        match reply.recv_timeout(REPLY_TIMEOUT) {
            Ok(reply) => Some(reply),
            Err(_) => {
                bridge.abandon(id);
                Some(error_reply(
                    line,
                    -32603,
                    "the deck did not answer (webview closed or busy)",
                ))
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_delivers_to_the_parked_receiver() {
        let bridge = McpBridge::default();
        let (id, rx) = bridge.begin();
        assert!(bridge.resolve(id, "reply".into()));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), "reply");
    }

    #[test]
    fn ids_are_distinct_and_never_the_notification_sentinel() {
        let bridge = McpBridge::default();
        let (a, _rx_a) = bridge.begin();
        let (b, _rx_b) = bridge.begin();
        assert_ne!(a, b);
        // The webview pump keys "no reply expected" on this exact value; a
        // parked request must never receive it.
        assert_ne!(a, NOTIFICATION_ID);
        assert_ne!(b, NOTIFICATION_ID);
    }

    #[test]
    fn resolve_after_abandon_reports_the_drop() {
        let bridge = McpBridge::default();
        let (id, rx) = bridge.begin();
        bridge.abandon(id);
        assert!(!bridge.resolve(id, "late".into()));
        assert!(rx.recv_timeout(Duration::from_millis(10)).is_err());
    }

    #[test]
    fn resolve_of_an_unknown_id_is_refused() {
        let bridge = McpBridge::default();
        assert!(!bridge.resolve(42, "ghost".into()));
    }

    #[test]
    fn error_reply_echoes_the_request_id() {
        let reply = error_reply(r#"{"jsonrpc":"2.0","id":7,"method":"x"}"#, -32603, "down");
        let parsed: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["error"]["code"], -32603);

        let string_id = error_reply(r#"{"id":"abc"}"#, -32603, "down");
        let parsed: serde_json::Value = serde_json::from_str(&string_id).unwrap();
        assert_eq!(parsed["id"], "abc");
    }

    #[test]
    fn error_reply_for_garbage_gets_a_null_id() {
        let reply = error_reply("not json at all", -32700, "parse");
        let parsed: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert!(parsed["id"].is_null());
    }

    #[test]
    fn error_reply_rejects_unroutable_id_types_like_the_webview_does() {
        // Mirrors jsonrpc.test.ts (same inputs, same nulls): booleans,
        // fractions, objects and beyond-2^53 integers are unroutable —
        // echoing one would break correlation (or lie, once a JS parser
        // has rounded it).
        for line in [
            r#"{"id":true}"#,
            r#"{"id":1.5}"#,
            r#"{"id":{}}"#,
            r#"{"id":9007199254740993}"#,
        ] {
            let parsed: serde_json::Value =
                serde_json::from_str(&error_reply(line, -32603, "x")).unwrap();
            assert!(parsed["id"].is_null(), "id must be null for {line}");
        }
    }

    #[test]
    fn error_reply_echoes_integer_valued_floats_as_integers_like_the_webview() {
        // Mirrors jsonrpc.test.ts: serde parses these as FLOATS, JSON.parse
        // as integers — the shared rule tests the value, not the token, so
        // both sides answer 100 and 1.
        for (line, want) in [(r#"{"id":1e2}"#, 100), (r#"{"id":1.0}"#, 1)] {
            let parsed: serde_json::Value =
                serde_json::from_str(&error_reply(line, -32603, "x")).unwrap();
            assert_eq!(parsed["id"], want, "for {line}");
        }
    }

    #[test]
    fn only_id_less_objects_are_notifications() {
        assert!(is_notification(r#"{"method":"notifications/initialized"}"#));
        assert!(!is_notification(r#"{"id":1,"method":"tools/list"}"#));
        // Garbage and non-objects stay requests: their senders expect SOME
        // answer, and the projection replies with a parse/invalid error.
        assert!(!is_notification("garbage"));
        assert!(!is_notification("[1,2]"));
        assert!(!is_notification("42"));
    }
}
