//! The bridge's WIRE layer: what an envelope is, and what it means.
//!
//! Format translation and nothing else — no filesystem, no transport, no Tauri.
//! It is also the only part of the bridge anyone outside it needs: the session
//! tailer emits the same shapes for what it recovers from transcripts, so the
//! webview sees one schema per event regardless of which side observed it.
//!
//! Envelopes are data, never code: schema-validated, and logged only after
//! control characters are stripped.

use serde::{Deserialize, Serialize};

/// Bridge protocol version — covers the `KEEPDECK_BRIDGE` env schema AND the
/// envelope schema, incremented on ANY change to either (a plain change
/// counter, plugin-API style). The host accepts the versions it supports;
/// everything else is logged and refused.
///
/// 2 dropped the file lane. Until then `url` was additive and an old reporter
/// that had never heard of it wrote a file instead — which is exactly why the
/// version had to move now: nothing watches for that file any more, so a
/// reporter left behind by an older install would report into nowhere and
/// look alive doing it. Refusing its envelopes is how it says so out loud.
pub const BRIDGE_PROTOCOL_VERSION: u64 = 2;

/// Event delivering one session binding to the webview (`src/ipc/sessions.ts`).
pub const SESSION_BOUND_EVENT: &str = "deck://session/bound";

/// Event delivering one usage report to the webview (`src/ipc/usage.ts`).
pub const USAGE_REPORT_EVENT: &str = "deck://usage/report";

/// Event delivering one agent-status report to the webview
/// (`src/ipc/status.ts`).
pub const AGENT_STATUS_EVENT: &str = "deck://agent/status";

/// One message dropped into the inbox. Unknown fields are ignored so
/// reporters may attach diagnostics.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    /// The protocol version the WRITER speaks.
    v: u64,
    /// Message type — the dispatch key.
    #[serde(rename = "type")]
    kind: String,
    /// Correlation: the pane whose spawn armed the reporter.
    #[serde(default)]
    pane_id: String,
    /// Per-spawn secret echoed back by the reporter.
    #[serde(default)]
    token: String,
    /// Type-specific body.
    #[serde(default)]
    payload: serde_json::Value,
}

/// The `session.bound` wire event (see `src/ipc/sessions.ts`). The webview
/// verifies `token` against the pane's spawn plan before binding — and, with
/// the fields below, whether the binding is the pane's own session at all.
/// Judging that is the webview's job in the same way the payload's MEANING
/// always was: this side carries and correlates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBound {
    pub pane_id: String,
    pub session_id: String,
    pub token: String,
    /// The session's transcript/rollout file, when the reporter knows it —
    /// what the codex usage tailer follows. Optional: older reporters and
    /// hook payloads without one still bind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// Which CLI reported this, as the arming site named it. REQUIRED, the
    /// same as on the opaque channels — a binding nobody signs is one every
    /// consumer refuses, so accepting it here would only move the failure a
    /// layer away from its cause.
    pub agent: String,
    /// The CLI's own word for why the session started, verbatim and
    /// unmapped: vocabularies differ per agent, so the normalizer that knows
    /// the agent is the one that can read it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Which PROCESS reported it — opaque here, and only ever compared for
    /// equality with the one that bound the pane's current generation. The
    /// bridge secret is inherited by a pane's whole process tree; this is
    /// what a nested run of the same agent cannot forge. Optional: a reporter
    /// that cannot name its own process says nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reporter: Option<String>,
}

/// An OPAQUE pane-correlated report — ONE wire shape for every channel that
/// passes its payload through verbatim (`usage.report` → `src/ipc/usage.ts`,
/// `agent.status` → `src/ipc/status.ts`). The webview's per-agent
/// normalizers own the payload schema (same division as deck.json: TS owns
/// meaning, Rust owns transport); the bridge guarantees only correlation
/// (pane, token) and the dispatch key (`payload.agent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pane_id: String,
    pub token: String,
    pub payload: serde_json::Value,
}

impl Report {
    /// The correlation this report is ASKING on, when it asks at all.
    ///
    /// Read here rather than at a transport, because the field's place in an
    /// envelope is this module's knowledge: a route that reached into the
    /// payload itself would be a second reader of the same shape, free to
    /// disagree with this one the day the shape moves.
    pub(super) fn correlation(&self) -> Option<&str> {
        self.payload
            .get("reply")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
    }
}

/// The opaque channels: envelope `type` → the webview event carrying it.
/// A new lane is one row here — validation and delivery are shared, so the
/// correlation contract cannot drift between lanes.
const OPAQUE_CHANNELS: &[(&str, &str)] = &[
    ("usage.report", USAGE_REPORT_EVENT),
    ("agent.status", AGENT_STATUS_EVENT),
];

/// One interpreted envelope — the dispatch result `deliver` emits from.
#[derive(Debug, PartialEq)]
pub(super) enum Inbound {
    SessionBound(SessionBound),
    Opaque {
        event: &'static str,
        report: Report,
    },
}

/// One optional string a reporter MAY have included. Absent, null, the wrong
/// type and empty all collapse to `None` — every consumer of these fields
/// already treats "not reported" as one case, and a shell reporter that omits
/// a field and one that emits `""` mean the same thing.
fn reported(payload: &serde_json::Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Parse and dispatch one envelope. The bridge is fed by shell hooks, so
/// anything malformed degrades to a logged reason, never an error path.
/// A NEW value in the open `type` namespace is not a protocol change — v1
/// readers consume-and-log unknown types by design; the version bumps only
/// when the envelope fields or `KEEPDECK_BRIDGE` schema move.
pub(super) fn interpret(content: &str) -> Result<Inbound, String> {
    let envelope: Envelope =
        serde_json::from_str(content).map_err(|_| "not an envelope".to_string())?;
    if envelope.v != BRIDGE_PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version {}", envelope.v));
    }
    match envelope.kind.as_str() {
        "session.bound" => {
            let session_id = envelope
                .payload
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            // `agent` is required here exactly as it is on the opaque arm
            // below: one decision, one strictness, one file.
            let agent = reported(&envelope.payload, "agent");
            let (Some(agent), false, false, false) = (
                agent,
                envelope.pane_id.is_empty(),
                envelope.token.is_empty(),
                session_id.is_empty(),
            ) else {
                return Err("session.bound with empty fields".into());
            };
            Ok(Inbound::SessionBound(SessionBound {
                transcript_path: reported(&envelope.payload, "transcriptPath"),
                source: reported(&envelope.payload, "source"),
                reporter: reported(&envelope.payload, "reporter"),
                pane_id: envelope.pane_id,
                session_id: session_id.to_string(),
                token: envelope.token,
                agent,
            }))
        }
        // One scan, no guard to re-prove: this module's contract is that
        // malformed input degrades to a logged reason, never a panic path.
        kind if let Some((_, event)) = OPAQUE_CHANNELS.iter().find(|(t, _)| *t == kind) => {
            let agent = envelope
                .payload
                .get("agent")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if envelope.pane_id.is_empty() || envelope.token.is_empty() || agent.is_empty() {
                return Err(format!("{kind} with empty fields"));
            }
            Ok(Inbound::Opaque {
                event,
                report: Report {
                    pane_id: envelope.pane_id,
                    token: envelope.token,
                    payload: envelope.payload,
                },
            })
        }
        other => Err(format!("unknown type \"{}\"", printable(other))),
    }
}

/// Reporter-supplied strings are untrusted — strip control characters and
/// cap length before they reach a log line.
pub(super) fn printable(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(80).collect()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A well-formed `session.bound` — `agent` included, because a binding
    /// without one is refused and every shipped reporter sends it.
    pub(in crate::bridge) fn envelope(
        v: u64,
        kind: &str,
        pane: &str,
        token: &str,
        session: &str,
    ) -> String {
        serde_json::json!({
            "v": v, "type": kind, "paneId": pane, "token": token,
            "payload": { "sessionId": session, "agent": "claude" },
        })
        .to_string()
    }

    fn usage_envelope(pane: &str, token: &str, agent: &str) -> String {
        serde_json::json!({
            "v": 2, "type": "usage.report", "paneId": pane, "token": token,
            "payload": { "agent": agent, "statusline": { "rate_limits": { "five_hour": { "used_percentage": 42 } } } },
        })
        .to_string()
    }

    fn status_envelope(pane: &str, token: &str, agent: &str) -> String {
        serde_json::json!({
            "v": 2, "type": "agent.status", "paneId": pane, "token": token,
            "payload": { "agent": agent, "event": { "hook_event_name": "Stop", "session_id": "abc" } },
        })
        .to_string()
    }

    #[test]
    fn interprets_a_session_bound_envelope_with_optional_transcript() {
        // Bare binding: no transcript. The envelope-level `agent` is an
        // unknown extra on purpose — `agent` is a PAYLOAD field, so one
        // sitting at envelope level must not be mistaken for the real one.
        let mut value: serde_json::Value =
            serde_json::from_str(&envelope(2, "session.bound", "pane-3", "tok", "abc")).unwrap();
        value["agent"] = "codex".into();
        value["payload"]["agent"] = "claude".into();
        assert_eq!(
            interpret(&value.to_string()),
            Ok(Inbound::SessionBound(SessionBound {
                pane_id: "pane-3".into(),
                session_id: "abc".into(),
                token: "tok".into(),
                transcript_path: None,
                agent: "claude".into(),
                source: None,
                reporter: None,
            }))
        );
        // With a transcript path — what the codex usage tailer follows.
        value["payload"]["transcriptPath"] = "/x/y.jsonl".into();
        assert_eq!(
            interpret(&value.to_string()),
            Ok(Inbound::SessionBound(SessionBound {
                pane_id: "pane-3".into(),
                session_id: "abc".into(),
                token: "tok".into(),
                transcript_path: Some("/x/y.jsonl".into()),
                agent: "claude".into(),
                source: None,
                reporter: None,
            }))
        );
        // An empty path is as good as none.
        value["payload"]["transcriptPath"] = "".into();
        let Ok(Inbound::SessionBound(bound)) = interpret(&value.to_string()) else {
            panic!("expected a binding");
        };
        assert_eq!(bound.transcript_path, None);
    }

    // The payload must ride through VERBATIM — the webview's normalizers own
    // its schema, and a lossy bridge would silently strip future fields.
    #[test]
    fn interprets_a_usage_report_passing_the_payload_through() {
        let result = interpret(&usage_envelope("pane-7", "tok", "claude"));
        let Ok(Inbound::Opaque {
            event: USAGE_REPORT_EVENT,
            report,
        }) = result
        else {
            panic!("expected a usage report, got {result:?}");
        };
        assert_eq!(report.pane_id, "pane-7");
        assert_eq!(report.token, "tok");
        assert_eq!(report.payload["agent"], "claude");
        assert_eq!(
            report.payload["statusline"]["rate_limits"]["five_hour"]["used_percentage"],
            42
        );
    }

    #[test]
    fn rejects_usage_reports_with_missing_correlation_or_agent() {
        assert!(interpret(&usage_envelope("", "tok", "claude")).is_err());
        assert!(interpret(&usage_envelope("pane-7", "", "claude")).is_err());
        assert!(interpret(&usage_envelope("pane-7", "tok", "")).is_err());
        // An agent field of the wrong type is as empty as a missing one.
        let mut value: serde_json::Value =
            serde_json::from_str(&usage_envelope("pane-7", "tok", "claude")).unwrap();
        value["payload"]["agent"] = 7.into();
        assert!(interpret(&value.to_string()).is_err());
    }

    // Like usage: the payload rides through VERBATIM — the webview's status
    // normalizers own its schema.
    #[test]
    fn interprets_a_status_report_passing_the_payload_through() {
        let result = interpret(&status_envelope("pane-7", "tok", "claude"));
        let Ok(Inbound::Opaque {
            event: AGENT_STATUS_EVENT,
            report,
        }) = result
        else {
            panic!("expected a status report, got {result:?}");
        };
        assert_eq!(report.pane_id, "pane-7");
        assert_eq!(report.token, "tok");
        assert_eq!(report.payload["agent"], "claude");
        assert_eq!(report.payload["event"]["hook_event_name"], "Stop");
    }

    #[test]
    fn rejects_status_reports_with_missing_correlation_or_agent() {
        assert!(interpret(&status_envelope("", "tok", "claude")).is_err());
        assert!(interpret(&status_envelope("pane-7", "", "claude")).is_err());
        assert!(interpret(&status_envelope("pane-7", "tok", "")).is_err());
    }

    #[test]
    fn rejects_unsupported_versions_and_unknown_types() {
        // 1 is not merely "not current": it is a reporter left behind by an
        // older install, which would have written a file nothing watches.
        assert!(interpret(&envelope(1, "session.bound", "p", "t", "s"))
            .is_err_and(|e| e.contains("version 1")));
        assert!(interpret(&envelope(3, "session.bound", "p", "t", "s"))
            .is_err_and(|e| e.contains("version 3")));
        assert!(interpret(&envelope(2, "session.stopped", "p", "t", "s"))
            .is_err_and(|e| e.contains("session.stopped")));
    }

    #[test]
    fn rejects_garbage_and_empty_fields() {
        assert!(interpret("not json").is_err());
        assert!(interpret("{}").is_err());
        assert!(interpret(&envelope(2, "session.bound", "", "t", "s")).is_err());
        assert!(interpret(&envelope(2, "session.bound", "p", "", "s")).is_err());
        assert!(interpret(&envelope(2, "session.bound", "p", "t", "")).is_err());
    }

    // The webview listens for this exact wire shape — pin it. An unreported
    // optional stays ABSENT (not null) so a listener can tell "the reporter
    // did not say" from any value it might have said.
    #[test]
    fn session_bound_serializes_camel_case() {
        let json = serde_json::to_value(SessionBound {
            pane_id: "pane-3".into(),
            session_id: "abc".into(),
            token: "tok".into(),
            agent: "claude".into(),
            transcript_path: None,
            source: None,
            reporter: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "paneId": "pane-3",
                "sessionId": "abc",
                "token": "tok",
                "agent": "claude",
            })
        );
        let json = serde_json::to_value(SessionBound {
            pane_id: "pane-3".into(),
            session_id: "abc".into(),
            token: "tok".into(),
            agent: "claude".into(),
            transcript_path: Some("/x/y.jsonl".into()),
            source: Some("startup".into()),
            reporter: Some("4021".into()),
        })
        .unwrap();
        assert_eq!(json["transcriptPath"], "/x/y.jsonl");
        assert_eq!(json["source"], "startup");
        assert_eq!(json["reporter"], "4021");
    }

    // A binding nobody signs is one every consumer refuses, so the bridge
    // refuses it where the opaque channels already do rather than emitting an
    // event whose only outcome is a warn line one layer away.
    #[test]
    fn a_session_bound_without_an_agent_is_refused() {
        let content = serde_json::json!({
            "v": 2,
            "type": "session.bound",
            "paneId": "pane-3",
            "token": "tok",
            "payload": { "sessionId": "abc" },
        })
        .to_string();
        assert!(interpret(&content).is_err());
    }

    // What the reporter said reaches the webview unjudged — including a
    // `source` this side has never heard of, because the vocabulary belongs
    // to the agent and the mapping lives with the agent's normalizer.
    #[test]
    fn session_bound_carries_the_reporters_attribution() {
        let content = serde_json::json!({
            "v": 2,
            "type": "session.bound",
            "paneId": "pane-3",
            "token": "tok",
            "payload": {
                "sessionId": "abc",
                "agent": "kimi",
                "source": "a-word-this-side-does-not-know",
                "reporter": "4021",
            },
        })
        .to_string();
        let Ok(Inbound::SessionBound(bound)) = interpret(&content) else {
            panic!("expected a session binding");
        };
        assert_eq!(bound.agent, "kimi");
        assert_eq!(
            bound.source.as_deref(),
            Some("a-word-this-side-does-not-know")
        );
        assert_eq!(bound.reporter.as_deref(), Some("4021"));
    }

    // An empty string is what a shell reporter emits for a field it could not
    // fill, and it must read the same as omitting it — otherwise the webview
    // has to know which reporters interpolate blanks.
    #[test]
    fn an_empty_attribution_reads_as_unreported() {
        let content = serde_json::json!({
            "v": 2,
            "type": "session.bound",
            "paneId": "pane-3",
            "token": "tok",
            "payload": {
                "sessionId": "abc",
                "agent": "claude",
                "source": "",
                "reporter": "",
            },
        })
        .to_string();
        let Ok(Inbound::SessionBound(bound)) = interpret(&content) else {
            panic!("expected a session binding");
        };
        assert_eq!(bound.source, None);
        assert_eq!(bound.reporter, None);
    }

    // Same pin for the opaque wire shape (`src/ipc/usage.ts`, `status.ts`).
    #[test]
    fn usage_report_serializes_camel_case() {
        let json = serde_json::to_value(Report {
            pane_id: "pane-7".into(),
            token: "tok".into(),
            payload: serde_json::json!({ "agent": "claude" }),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "paneId": "pane-7", "token": "tok", "payload": { "agent": "claude" },
            })
        );
    }

    #[test]
    fn log_strings_lose_control_characters() {
        assert_eq!(printable("a\x1b[31mb\nc"), "a[31mbc");
    }
}
