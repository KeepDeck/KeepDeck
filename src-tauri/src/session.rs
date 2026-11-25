//! Session delivery layer: bridges the `keepdeck-pty` process layer to the
//! webview. Clean-architecture boundary — this adapter depends on the
//! `keepdeck-pty` domain crate, never the reverse.
//!
//! It is what the sessions machine's spawn door shares: the spawn request's
//! wire shape, the program it resolves to, and the delivery that forwards a
//! session's [`PtyEvent`]s to its per-session channel. Who owns a process
//! and when it stops is the sessions machine's.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use keepdeck_pty::{Consumer, ExitInfo, PtyEvent};
use serde::{Deserialize, Serialize};

/// The spawn request on the wire. `command` defaults to the user's shell.
/// camelCase like every multi-word wire DTO: Tauri's own case conversion
/// covers command PARAMETER names only — struct FIELDS are raw serde, and a
/// missing rename here once made `envDefaults` silently deserialize to an
/// empty default (opencode skills died without a single error).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub env_defaults: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// The pane's secrets, as its plan minted them: whoever names one a door
    /// counts, from this terminal, speaks for its pane
    /// (`keepdeck_pty::sessions::judge_caller`). None for a session that is
    /// no pane's.
    #[serde(default)]
    pub secrets: SpawnSecrets,
}

/// A pane's two secrets on the wire, one per door: the MCP server's and the
/// bridge's. An empty one is none.
#[derive(Debug, Default, Deserialize)]
pub struct SpawnSecrets {
    pub mcp: Option<String>,
    pub bridge: Option<String>,
}

/// Event DTO streamed to the webview over the per-session channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    /// Output bytes from the PTY, base64 — at most [`OUTPUT_MESSAGE_BYTES`]
    /// of them per message. As a JSON array of numbers every terminal byte
    /// cost the page 13–18 bytes of garbage; as base64, 3–5.
    Output { data: String },
    /// The session's child process exited.
    Exit { success: bool, code: Option<u32> },
}

impl SessionEvent {
    fn exit(info: ExitInfo) -> Self {
        SessionEvent::Exit {
            success: info.success,
            code: info.code,
        }
    }
}

/// Largest slice of terminal output one channel message carries.
///
/// Tauri runs a channel message whose JSON is under 8192 bytes straight in the
/// page, and parks anything bigger in a queue in this process — one with no
/// bound, emptied only when the page fetches each entry back
/// (`ChannelDataIpcQueue`). 5 632 bytes encode to 7 512 base64 characters,
/// which with the event's framing stays under that line, so terminal output
/// never takes the queued path: a larger run is split across messages.
const OUTPUT_MESSAGE_BYTES: usize = 5632;

/// How long delivery holds output for more before sending it. A repaint
/// arrives as a burst of small reads; sent as one message instead of one per
/// read, its bytes cost the page about half the garbage (~5 bytes per byte in
/// a 512-byte message, ~2.7 in a 4 KB one). Eight milliseconds is half a
/// frame, under what a keystroke's echo can be felt to lag by.
const OUTPUT_COALESCE: Duration = Duration::from_millis(8);

/// The messages one run of output crosses as.
fn output_messages(bytes: &[u8]) -> impl Iterator<Item = SessionEvent> + '_ {
    bytes
        .chunks(OUTPUT_MESSAGE_BYTES)
        .map(|chunk| SessionEvent::Output {
            data: BASE64.encode(chunk),
        })
}

/// Why a session's delivery stopped.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DeliveryEnd {
    /// The child exited; its exit was the last event sent.
    Exited,
    /// The page dropped the channel (reload, close).
    ChannelGone,
    /// The process layer closed without reporting an exit.
    ProducerGone,
}

/// Forward a session's events to `send` until it ends.
///
/// Output is held for up to [`OUTPUT_COALESCE`] from its first byte, or until
/// a message's worth has gathered, then sent as [`output_messages`]; whatever
/// is held goes out before the exit, so output always precedes it. `send`
/// answers `false` once the channel is gone. The drop marker is read per
/// chunk as the queue hands it over — it travels as a chunk of its own there —
/// before any merging.
pub(crate) fn deliver(
    events: &Consumer,
    session_id: &str,
    mut send: impl FnMut(SessionEvent) -> bool,
) -> DeliveryEnd {
    let mut held: Vec<u8> = Vec::new();
    let mut held_since = Instant::now();
    loop {
        let next = if held.is_empty() {
            events.recv()
        } else {
            match OUTPUT_COALESCE.checked_sub(held_since.elapsed()) {
                Some(left) if !left.is_zero() => events.recv_timeout(left),
                _ => None,
            }
        };
        match next {
            Some(PtyEvent::Output(bytes)) => {
                // The queue marks output it had to drop; this is the one place
                // that reads the mark, so a stall long enough to lose bytes
                // leaves a trace in the log and not only on the screen. It
                // arrives when the mark is finally drained — i.e. once
                // delivery is moving again.
                if let Some(lost) = keepdeck_pty::parse_drop_marker(&bytes) {
                    log::warn!(
                        "session {session_id}: output dropped — {lost} bytes lost to a stalled consumer"
                    );
                }
                if held.is_empty() {
                    held_since = Instant::now();
                }
                held.extend_from_slice(&bytes);
                if held.len() >= OUTPUT_MESSAGE_BYTES && !send_held(&mut held, &mut send) {
                    return DeliveryEnd::ChannelGone;
                }
            }
            Some(PtyEvent::Exited(info)) => {
                if !send_held(&mut held, &mut send) || !send(SessionEvent::exit(info)) {
                    return DeliveryEnd::ChannelGone;
                }
                return DeliveryEnd::Exited;
            }
            // Nothing held means `recv` waited and the producer is gone.
            None if held.is_empty() => return DeliveryEnd::ProducerGone,
            // The window closed (or the producer left — the next `recv` says).
            None => {
                if !send_held(&mut held, &mut send) {
                    return DeliveryEnd::ChannelGone;
                }
            }
        }
    }
}

/// Send what delivery holds and empty it; `false` once the channel is gone.
fn send_held(held: &mut Vec<u8>, send: &mut impl FnMut(SessionEvent) -> bool) -> bool {
    let delivered = output_messages(held).all(send);
    held.clear();
    delivered
}

/// Resolve the program to spawn: an explicit non-blank command wins, else the
/// caller's shell, else `/bin/sh`. Pure so it can be unit tested.
pub(crate) fn resolve_command(command: Option<String>, shell: Option<String>) -> String {
    nonblank(command)
        .or_else(|| nonblank(shell))
        .unwrap_or_else(|| "/bin/sh".to_string())
}

fn nonblank(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The webview sends camelCase keys; the FIELD names are raw serde (no
    /// Tauri conversion) — this pins the wire shape end to end, especially
    /// the multi-word `envDefaults`. The sending side's wrapper must pin the
    /// same shape — change both together.
    #[test]
    fn spawn_spec_deserializes_the_webviews_camel_case_wire() {
        let spec: SpawnSpec = serde_json::from_str(
            r#"{
                "command": "opencode",
                "args": ["-s", "x"],
                "env": [["A", "1"]],
                "envDefaults": [["OPENCODE_CONFIG_DIR", "/kd/opencode/ws-1"]],
                "cwd": "/repo",
                "cols": 80,
                "rows": 24,
                "secrets": { "mcp": "s-mcp", "bridge": "s-bridge" }
            }"#,
        )
        .unwrap();
        assert_eq!(
            spec.env_defaults,
            vec![("OPENCODE_CONFIG_DIR".to_string(), "/kd/opencode/ws-1".to_string())],
        );
        assert_eq!(spec.secrets.mcp.as_deref(), Some("s-mcp"));
        assert_eq!(spec.secrets.bridge.as_deref(), Some("s-bridge"));
        // And the snake_case spelling must NOT be accepted silently.
        let wrong: SpawnSpec = serde_json::from_str(
            r#"{"command": null, "args": [], "env": [],
                "env_defaults": [["K", "V"]], "cwd": null, "cols": 1, "rows": 1}"#,
        )
        .unwrap_or_else(|_| SpawnSpec {
            command: None,
            args: vec![],
            env: vec![],
            env_defaults: vec![],
            cwd: None,
            cols: 1,
            rows: 1,
            secrets: SpawnSecrets::default(),
        });
        assert!(wrong.env_defaults.is_empty());
    }

    /// A spec in the form sent before spawns carried secrets still reads,
    /// and names none: a session that is no pane's. So does one that names
    /// a single door's.
    #[test]
    fn a_spawn_spec_without_secrets_or_with_one_still_reads() {
        let old: SpawnSpec = serde_json::from_str(
            r#"{"command": null, "args": [], "env": [], "envDefaults": [], "cwd": null, "cols": 1, "rows": 1}"#,
        )
        .expect("a spec without secrets reads");
        assert!(old.secrets.mcp.is_none() && old.secrets.bridge.is_none());
        let one: SpawnSpec = serde_json::from_str(
            r#"{"command": null, "cols": 1, "rows": 1, "cwd": null, "secrets": { "bridge": "s-bridge" }}"#,
        )
        .expect("a spec with one secret reads");
        assert!(one.secrets.mcp.is_none());
        assert_eq!(one.secrets.bridge.as_deref(), Some("s-bridge"));
    }

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

    fn decoded(events: &[SessionEvent]) -> Vec<u8> {
        events
            .iter()
            .flat_map(|event| match event {
                SessionEvent::Output { data } => BASE64.decode(data).expect("base64 output"),
                SessionEvent::Exit { .. } => Vec::new(),
            })
            .collect()
    }

    /// The most the output queue ever hands over in one chunk is 64 KiB.
    #[test]
    fn no_output_message_reaches_the_channel_queue_threshold() {
        let run: Vec<u8> = (0..64 * 1024).map(|i| (i % 251) as u8).collect();
        let messages: Vec<SessionEvent> = output_messages(&run).collect();
        assert!(messages.len() > 1, "a long run is split");
        for message in &messages {
            let json = serde_json::to_string(message).expect("serialises");
            assert!(
                json.len() < 8192,
                "a {}-byte message would be queued",
                json.len()
            );
        }
        assert_eq!(
            decoded(&messages),
            run,
            "splitting loses and reorders nothing"
        );
    }

    #[test]
    fn output_crosses_as_base64() {
        let json = serde_json::to_string(&output_messages(b"hi").next().unwrap()).unwrap();
        assert_eq!(json, r#"{"type":"output","data":"aGk="}"#);
    }

    fn queue_of(events: Vec<PtyEvent>) -> Consumer {
        let (producer, consumer) = keepdeck_pty::OutputQueue::new(1 << 20).split();
        for event in events {
            producer.push(event);
        }
        consumer
    }

    #[test]
    fn held_output_goes_out_before_the_exit() {
        let consumer = queue_of(vec![
            PtyEvent::Output(b"a".to_vec()),
            PtyEvent::Output(b"b".to_vec()),
            PtyEvent::Exited(ExitInfo {
                success: true,
                code: Some(0),
            }),
        ]);
        let mut sent = Vec::new();
        let end = deliver(&consumer, "s", |event| {
            sent.push(event);
            true
        });
        assert_eq!(end, DeliveryEnd::Exited);
        assert_eq!(decoded(&sent), b"ab");
        assert_eq!(
            sent.last(),
            Some(&SessionEvent::Exit {
                success: true,
                code: Some(0)
            })
        );
    }

    #[test]
    fn output_held_when_the_producer_leaves_is_still_sent() {
        let consumer = queue_of(vec![PtyEvent::Output(b"tail".to_vec())]);
        let mut sent = Vec::new();
        let end = deliver(&consumer, "s", |event| {
            sent.push(event);
            true
        });
        assert_eq!(end, DeliveryEnd::ProducerGone);
        assert_eq!(decoded(&sent), b"tail");
    }

    #[test]
    fn a_gone_channel_ends_delivery() {
        let consumer = queue_of(vec![
            PtyEvent::Output(b"x".to_vec()),
            PtyEvent::Exited(ExitInfo {
                success: true,
                code: Some(0),
            }),
        ]);
        let mut attempts = 0;
        let end = deliver(&consumer, "s", |_| {
            attempts += 1;
            false
        });
        assert_eq!(end, DeliveryEnd::ChannelGone);
        assert_eq!(attempts, 1, "nothing is sent after the channel is gone");
    }

    #[test]
    fn output_apart_by_more_than_the_window_goes_as_separate_messages() {
        let (producer, consumer) = keepdeck_pty::OutputQueue::new(1 << 20).split();
        let writer = std::thread::spawn(move || {
            producer.push(PtyEvent::Output(b"first".to_vec()));
            std::thread::sleep(OUTPUT_COALESCE * 12);
            producer.push(PtyEvent::Output(b"second".to_vec()));
        });
        let mut sent = Vec::new();
        let end = deliver(&consumer, "s", |event| {
            sent.push(event);
            true
        });
        writer.join().unwrap();
        assert_eq!(end, DeliveryEnd::ProducerGone);
        assert_eq!(sent.len(), 2, "the first burst did not wait for the second");
        assert_eq!(decoded(&sent), b"firstsecond");
    }
}
