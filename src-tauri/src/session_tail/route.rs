//! The wire builders and the two-channel routing decision: a drained event
//! becomes a usage report, a status report (interrupt markers), or nothing.
//! Pure — the module this file's callers emit through owns the Tauri side.

use serde_json::json;

use super::dialects::{TailedEvent, CARRIED_RECORD};
use crate::bridge::Report;

/// The transport keys `wrap` writes and `route` reads back. One set of
/// names on purpose: `Value` indexing on a missing key yields `Null`, not
/// an error, so a rename drifting between the two functions would silently
/// classify every interrupt as plain usage.
const EVENT_KEY: &str = "event";
const CATCH_UP_KEY: &str = "catchUp";

/// Wrap one session-file event into the bridge's wire shape. `agent` and
/// `catchUp` are HOST-owned transport keys on the payload: `catchUp` marks
/// events replayed from the EXISTING file (arm-time drain, or a rotated poll
/// tick) — the store must not let a replay outrank live data.
pub(super) fn wrap(
    pane_id: &str,
    token: &str,
    agent: &str,
    event: TailedEvent,
    catch_up: bool,
) -> Report {
    let mut payload = json!({
        "agent": agent,
        EVENT_KEY: event.payload,
        CATCH_UP_KEY: catch_up,
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
    // A record a dialect asked to have carried is not this side's reading of
    // anything — it travels as itself, and what it MEANS is applied by the
    // plugin that named it. It rides the status channel because that is the
    // only channel a dialect answers on today.
    //
    // This used to branch on `session.interrupt`, a word this side minted
    // after deciding for itself what a transcript line meant. Both agents
    // that had such a line now read their own, so nothing mints it and the
    // branch is gone with them.
    if report.payload[EVENT_KEY]["type"] != CARRIED_RECORD {
        return Routed::Usage(report);
    }
    // The lane the dialect DECLARED. A record about the numbers rides the
    // usage channel and keeps the wrapper it came in — its normalizer reads
    // the whole envelope, catch-up mark included, because restoring the last
    // known cost after a restart is exactly what a replay is for.
    if report.payload[EVENT_KEY]["lane"] == "usage" {
        return Routed::Usage(report);
    }
    // A status edge from a replay is a turn that ended before this deck was
    // looking, and acting on it would end the turn running now.
    if report.payload[CATCH_UP_KEY] == true {
        return Routed::Drop;
    }
    let mut body = json!({
        "agent": report.payload["agent"],
        "kind": CARRIED_RECORD,
        "record": report.payload[EVENT_KEY]["record"],
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
            slot: Some(0),
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

        let carried = wrap(
            "pane-1",
            "tok",
            "codex",
            event(serde_json::json!({
                "type": CARRIED_RECORD,
                "record": { "timestamp": "2026-08-01T10:00:00Z", "payload.type": "turn_aborted" },
            })),
            false,
        );
        let Routed::Status(status) = route(carried) else {
            panic!("a carried record must switch channels");
        };
        assert_eq!(status.pane_id, "pane-1");
        assert_eq!(status.token, "tok");
        assert_eq!(status.payload["agent"], "codex");
        assert_eq!(status.payload["kind"], CARRIED_RECORD);
        // The record travels whole and unread: this side does not know that
        // any of it is an abort.
        assert_eq!(status.payload["record"]["payload.type"], "turn_aborted");
        // The marker's own time survives the reshape — the tracker's
        // stale-marker guard depends on it.
        assert_eq!(status.payload["sourceAt"], "2026-08-01T10:00:00Z");
        assert_eq!(status.payload["sourceMtimeMs"], 1234);
    }

    #[test]
    fn a_replayed_interrupt_is_dropped_whole() {
        // A record read out of the EXISTING file describes a turn that ended
        // before this deck was looking. Acted on, it would end the turn
        // running right now — so it never reaches the channel at all.
        let replay = wrap(
            "pane-1",
            "tok",
            "claude",
            event(serde_json::json!({
                "type": CARRIED_RECORD,
                "record": { "interruptedMessageId": "msg-1" },
            })),
            true,
        );
        assert_eq!(route(replay), Routed::Drop);
    }
}
