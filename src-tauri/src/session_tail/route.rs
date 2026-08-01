//! The wire builders and the two-channel routing decision: a drained event
//! becomes a usage report, a status report (interrupt markers), or nothing.
//! Pure — the module this file's callers emit through owns the Tauri side.

use serde_json::json;

use super::dialects::TailedEvent;
use crate::bridge::Report;

/// Wrap one session-file event into the bridge's wire shape. `agent` and
/// `catchUp` are HOST-owned transport keys on the payload: `catchUp` marks
/// events replayed from the EXISTING file (arm-time drain, or a rotated poll
/// tick) — the store must not let a replay outrank live data.
pub(super) fn wrap(
    pane_id: &str,
    token: &str,
    agent: &'static str,
    event: TailedEvent,
    catch_up: bool,
) -> Report {
    let mut payload = json!({
        "agent": agent,
        "event": event.payload,
        "catchUp": catch_up,
    });
    if let Some(source_at) = event.source_at {
        payload["sourceAt"] = json!(source_at);
    }
    if let Some(source_mtime_ms) = event.source_mtime_ms {
        payload["sourceMtimeMs"] = json!(source_mtime_ms);
    }
    Report {
        pane_id: pane_id.to_string(),
        token: token.to_string(),
        payload,
    }
}

/// Where one wrapped report goes.
#[derive(Debug, PartialEq)]
pub(super) enum Routed {
    /// An ordinary usage event → `deck://usage/report`.
    Usage(Report),
    /// An interrupt marker → `deck://agent/status`, reshaped to the status
    /// payload (`kind`/`reason` + provenance) the plugin normalizers read.
    Status(Report),
    /// A replayed interrupt: an old abort must never fire as if fresh.
    Drop,
}

/// Route one wrapped report. An interrupt marker is a STATUS edge, not
/// usage — it moves channels with the same correlation, keeping its source
/// time so the tracker can drop a marker that predates the turn it would
/// end. Everything else is usage, catch-up or live alike.
pub(super) fn route(report: Report) -> Routed {
    if report.payload["event"]["type"] != "session.interrupt" {
        return Routed::Usage(report);
    }
    if report.payload["catchUp"] == true {
        return Routed::Drop;
    }
    let mut body = json!({
        "agent": report.payload["agent"],
        "kind": "session.interrupt",
        "reason": report.payload["event"]["reason"],
    });
    for key in ["sourceAt", "sourceMtimeMs"] {
        if !report.payload[key].is_null() {
            body[key] = report.payload[key].clone();
        }
    }
    Routed::Status(Report {
        pane_id: report.pane_id,
        token: report.token,
        payload: body,
    })
}

#[cfg(test)]
mod tests {
    use super::super::dialects::SourceTimestamp;
    use super::*;

    fn event(payload: serde_json::Value) -> TailedEvent {
        TailedEvent {
            payload,
            source_at: Some(SourceTimestamp::Iso("2026-08-01T10:00:00Z".into())),
            source_mtime_ms: Some(1234),
            root: true,
        }
    }

    // The two-channel decision itself — a typo in either literal or a
    // reshaped wrap() would silently send interrupts down the usage lane,
    // where the usage normalizers drop them and the pane never leaves
    // "working" after an Esc.
    #[test]
    fn routes_usage_through_and_interrupts_to_status_with_provenance() {
        let usage = wrap(
            "pane-1",
            "tok",
            "codex",
            event(serde_json::json!({ "type": "token_count" })),
            false,
        );
        assert!(matches!(route(usage), Routed::Usage(_)));

        let marker = wrap(
            "pane-1",
            "tok",
            "codex",
            event(serde_json::json!({ "type": "session.interrupt", "reason": "interrupted" })),
            false,
        );
        let Routed::Status(status) = route(marker) else {
            panic!("an interrupt marker must switch channels");
        };
        assert_eq!(status.pane_id, "pane-1");
        assert_eq!(status.token, "tok");
        assert_eq!(status.payload["agent"], "codex");
        assert_eq!(status.payload["kind"], "session.interrupt");
        assert_eq!(status.payload["reason"], "interrupted");
        // The marker's own time survives the reshape — the tracker's
        // stale-marker guard depends on it.
        assert_eq!(status.payload["sourceAt"], "2026-08-01T10:00:00Z");
        assert_eq!(status.payload["sourceMtimeMs"], 1234);
    }

    #[test]
    fn a_replayed_interrupt_is_dropped_whole() {
        let replay = wrap(
            "pane-1",
            "tok",
            "claude",
            event(serde_json::json!({ "type": "session.interrupt", "reason": "interrupted" })),
            true,
        );
        assert_eq!(route(replay), Routed::Drop);
    }
}
