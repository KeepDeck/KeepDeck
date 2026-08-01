//! Running per-session token cumulatives for the formats whose files expose
//! per-request rows rather than a native total. Pure folds over events.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::dialects::{TailFormat, TailedEvent};

/// Kimi's running per-tail token cumulative. Kimi writes only per-request
/// counts (`usage.record`), never a session total, and catch-up collapses to
/// the last record — so the sum is held here and stamped onto each event as
/// `sessionTotals`. Each bucket sums SEPARATELY: `inputCacheRead` is the
/// re-read context prefix (occupancy), NOT fresh input, so it never joins the
/// fresh-input total. Stays zero for codex, which carries its own cumulative.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct KimiTotals {
    pub(super) input_other: u64,
    pub(super) output: u64,
    pub(super) input_cache_read: u64,
    pub(super) input_cache_creation: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ClaudeUsage {
    pub(super) input: u64,
    pub(super) output: u64,
    pub(super) cache_read: u64,
    pub(super) cache_creation: u64,
}

impl ClaudeUsage {
    fn max(self, other: Self) -> Self {
        Self {
            input: self.input.max(other.input),
            output: self.output.max(other.output),
            cache_read: self.cache_read.max(other.cache_read),
            cache_creation: self.cache_creation.max(other.cache_creation),
        }
    }

    fn add_assign(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
    }

    fn subtract(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_sub(other.input),
            output: self.output.saturating_sub(other.output),
            cache_read: self.cache_read.saturating_sub(other.cache_read),
            cache_creation: self.cache_creation.saturating_sub(other.cache_creation),
        }
    }
}

/// Claude repeats one assistant message id across content/tool rows. Keep the
/// per-id maxima (the CLI's documented dedup rule) and a running session sum.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ClaudeTotals {
    pub(super) by_message: HashMap<String, ClaudeUsage>,
    pub(super) sum: ClaudeUsage,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SessionTotals {
    pub(super) kimi: KimiTotals,
    pub(super) claude: ClaudeTotals,
}

/// Fold per-request/message token buckets into running session cumulatives and
/// stamp `sessionTotals` onto the event. Kimi sums every usage record. Claude
/// deduplicates repeated assistant rows by message id, retaining each bucket's
/// maximum. Codex carries a native cumulative and passes through untouched.
pub(super) fn accumulate_session_totals(
    totals: &mut SessionTotals,
    format: TailFormat,
    event: &mut TailedEvent,
) {
    let kind = event.payload.get("type").and_then(Value::as_str);
    match (format, kind) {
        (TailFormat::KimiWire, Some("usage.record")) => {
            let usage = event.payload.get("usage");
            let bucket = |key: &str| {
                usage
                    .and_then(|u| u.get(key))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            totals.kimi.input_other += bucket("inputOther");
            totals.kimi.output += bucket("output");
            totals.kimi.input_cache_read += bucket("inputCacheRead");
            totals.kimi.input_cache_creation += bucket("inputCacheCreation");
            if let Some(object) = event.payload.as_object_mut() {
                object.insert(
                    "sessionTotals".to_string(),
                    json!({
                        "inputOther": totals.kimi.input_other,
                        "output": totals.kimi.output,
                        "inputCacheRead": totals.kimi.input_cache_read,
                        "inputCacheCreation": totals.kimi.input_cache_creation,
                    }),
                );
            }
        }
        (TailFormat::Claude, Some("assistant.usage")) => {
            let Some(message_id) = event
                .payload
                .get("messageId")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                return;
            };
            let usage = event.payload.get("usage");
            let bucket = |key: &str| {
                usage
                    .and_then(|u| u.get(key))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            let incoming = ClaudeUsage {
                input: bucket("input_tokens"),
                output: bucket("output_tokens"),
                cache_read: bucket("cache_read_input_tokens"),
                cache_creation: bucket("cache_creation_input_tokens"),
            };
            let previous = totals
                .claude
                .by_message
                .get(&message_id)
                .copied()
                .unwrap_or_default();
            let next = previous.max(incoming);
            totals.claude.sum.add_assign(next.subtract(previous));
            totals.claude.by_message.insert(message_id, next);

            if let Some(object) = event.payload.as_object_mut() {
                object.insert(
                    "sessionTotals".to_string(),
                    json!({
                        "input_tokens": totals.claude.sum.input,
                        "output_tokens": totals.claude.sum.output,
                        "cache_read_input_tokens": totals.claude.sum.cache_read,
                        "cache_creation_input_tokens": totals.claude.sum.cache_creation,
                    }),
                );
            }
        }
        _ => {}
    }
}
