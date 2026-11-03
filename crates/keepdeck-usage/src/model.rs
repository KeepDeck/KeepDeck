//! The ledger's vocabulary, shaped as the webview speaks it (camelCase).

use serde::{Deserialize, Serialize};

/// Token counters, by kind. Each one is optional: a provider reports the
/// kinds it has. Counts are kept as the JSON numbers they arrive as.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
}

/// Every counter kind, in one order — the one list every walk over the kinds
/// goes through.
pub const TOKEN_KINDS: [TokenKind; 6] = [
    TokenKind::Input,
    TokenKind::Output,
    TokenKind::CacheRead,
    TokenKind::CacheWrite,
    TokenKind::Reasoning,
    TokenKind::Total,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Input,
    Output,
    CacheRead,
    CacheWrite,
    Reasoning,
    Total,
}

impl TokenCounts {
    pub fn get(&self, kind: TokenKind) -> Option<f64> {
        match kind {
            TokenKind::Input => self.input,
            TokenKind::Output => self.output,
            TokenKind::CacheRead => self.cache_read,
            TokenKind::CacheWrite => self.cache_write,
            TokenKind::Reasoning => self.reasoning,
            TokenKind::Total => self.total,
        }
    }

    pub fn set(&mut self, kind: TokenKind, value: Option<f64>) {
        let slot = match kind {
            TokenKind::Input => &mut self.input,
            TokenKind::Output => &mut self.output,
            TokenKind::CacheRead => &mut self.cache_read,
            TokenKind::CacheWrite => &mut self.cache_write,
            TokenKind::Reasoning => &mut self.reasoning,
            TokenKind::Total => &mut self.total,
        };
        *slot = value;
    }

    pub fn is_empty(&self) -> bool {
        TOKEN_KINDS.iter().all(|kind| self.get(*kind).is_none())
    }

    /// Add `other` kind by kind; a kind absent on both sides stays absent.
    pub fn add(&mut self, other: &TokenCounts) {
        for kind in TOKEN_KINDS {
            if let Some(more) = other.get(kind) {
                self.set(kind, Some(self.get(kind).unwrap_or(0.0) + more));
            }
        }
    }
}

/// The cumulative counters a session last reported — the base the next
/// report's delta is taken against.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    #[serde(default)]
    pub tokens: TokenCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// One cumulative report from a pane: what its provider says the session has
/// used so far.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub total_tokens: Option<TokenCounts>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    pub reported_at: f64,
    /// The provider's own ordering of its reports, when it has one.
    #[serde(default)]
    pub sequence: Option<f64>,
}

/// Where a session came from — whether its first report is a baseline or
/// real usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionOrigin {
    /// This run's own spawn minted the session: its first turn is real usage.
    Fresh,
    /// Resumed or forked: the counters already hold work the ledger may hold.
    Inherited,
    /// No spawn plan for the pane: attached or restored.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub repo: String,
}

/// The deck's facts about the pane a report came from.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureContext {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_cwd: String,
    pub pane_id: String,
    pub pane_name: String,
    pub session_id: String,
    pub origin: SessionOrigin,
    #[serde(default)]
    pub worktree: Option<Worktree>,
}

/// One row of the ledger as the webview reads it: either one recorded event
/// (`count` 1) or a compacted bucket of a session's events. Its fields are an
/// event's, so every derivation reads both alike; the three weights say how
/// many events, provider calls and priced events the row stands for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub event_id: String,
    pub occurred_at: f64,
    pub captured_at: f64,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_cwd: String,
    pub pane_id: String,
    pub pane_name: String,
    pub session_id: String,
    pub root_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    pub tokens: TokenCounts,
    pub cost_source: CostSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub count: u32,
    pub calls: u32,
    pub cost_events: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CostSource {
    Provider,
    Unavailable,
}
