//! The ledger's vocabulary, shaped as the webview speaks it (camelCase).

use serde::{Deserialize, Serialize};

use crate::pricing::CostBasis;

/// Token counters, by kind. Each one is optional: a row reports the kinds it
/// has. Counts are kept as the JSON numbers they arrive as.
///
/// The classes are the canonical ones every agent's usage is mapped into
/// before it is booked: `input` is FRESH input (neither read from nor
/// written to a cache), `output` is everything billed as output — reasoning
/// included, `reasoning` being a share of it shown on its own — and `total`
/// is the sum of the billed classes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// Cache writes held for five minutes — the default write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    /// Cache writes held for an hour (Anthropic), billed at their own rate.
    #[serde(default, rename = "cacheWrite1h", skip_serializing_if = "Option::is_none")]
    pub cache_write_1h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
}

/// Every counter kind, in one order — the one list every walk over the kinds
/// goes through.
pub const TOKEN_KINDS: [TokenKind; 7] = [
    TokenKind::Input,
    TokenKind::Output,
    TokenKind::CacheRead,
    TokenKind::CacheWrite,
    TokenKind::CacheWrite1h,
    TokenKind::Reasoning,
    TokenKind::Total,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Input,
    Output,
    CacheRead,
    CacheWrite,
    CacheWrite1h,
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
            TokenKind::CacheWrite1h => self.cache_write_1h,
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
            TokenKind::CacheWrite1h => &mut self.cache_write_1h,
            TokenKind::Reasoning => &mut self.reasoning,
            TokenKind::Total => &mut self.total,
        };
        *slot = value;
    }

    /// Whether no kind counts anything.
    pub fn is_empty(&self) -> bool {
        TOKEN_KINDS
            .iter()
            .all(|kind| self.get(*kind).is_none_or(|value| value == 0.0))
    }

    /// Add `other` kind by kind; a kind absent on both sides stays absent.
    pub fn add(&mut self, other: &TokenCounts) {
        for kind in TOKEN_KINDS {
            if let Some(more) = other.get(kind) {
                self.set(kind, Some(self.get(kind).unwrap_or(0.0) + more));
            }
        }
    }

    /// The prompt a call sent: everything it read, fresh or cached — what a
    /// long-context threshold is measured against.
    pub fn prompt(&self) -> f64 {
        self.input.unwrap_or(0.0)
            + self.cache_read.unwrap_or(0.0)
            + self.cache_write.unwrap_or(0.0)
            + self.cache_write_1h.unwrap_or(0.0)
    }

    /// The sum of the billed classes — the row's total.
    pub fn billed(&self) -> f64 {
        self.prompt() + self.output.unwrap_or(0.0)
    }
}

/// One provider API call's tokens, in the canonical classes (see
/// [`TokenCounts`]). Every class is a count; an agent that does not report
/// one sends 0.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CallTokens {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    #[serde(rename = "cacheWrite1h")]
    pub cache_write_1h: f64,
    pub output: f64,
    pub reasoning: f64,
}

impl CallTokens {
    /// As ledger counters, every class present and the total the sum of the
    /// billed ones.
    pub fn counts(&self) -> TokenCounts {
        let finite = |value: f64| if value.is_finite() && value > 0.0 { value } else { 0.0 };
        let mut counts = TokenCounts {
            input: Some(finite(self.input)),
            output: Some(finite(self.output)),
            cache_read: Some(finite(self.cache_read)),
            cache_write: Some(finite(self.cache_write)),
            cache_write_1h: Some(finite(self.cache_write_1h)),
            reasoning: Some(finite(self.reasoning)),
            total: None,
        };
        counts.total = Some(counts.billed());
        counts
    }
}

/// One provider API call, as an agent's plugin reported it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCall {
    /// Unique within the agent: claude's `message.id`, codex's
    /// `response_id`, opencode's step id, or a file position for an agent
    /// with no id of its own.
    pub id: String,
    /// When the call happened, unix ms — the record's own time.
    pub at: f64,
    /// Who served it, as the agent says: the maker, or a reseller the price
    /// journal resolves to the maker.
    pub provider: String,
    pub model: String,
    /// The catalogue's name for the service-tier mode it ran in ("fast");
    /// absent for the standard tier.
    #[serde(default)]
    pub mode: Option<String>,
    pub tokens: CallTokens,
    /// Set when this is no single call but the agent's own running total of
    /// what the session spent on the model — see [`Tally`].
    #[serde(default)]
    pub tally: Option<Tally>,
}

/// What makes a reported "call" a running total: the agent's own count of
/// everything the session spent on one model since `began` — its calls,
/// and what no call record shows (claude's compaction, away summaries,
/// titles). The same id every time for one count; the ledger books what the
/// total adds over the calls it booked for the session in between.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    /// When the count started, unix ms: it ran from zero then.
    pub began: f64,
}

impl UsageCall {
    /// The key the call's usage is booked under: `<provider>/<model>`.
    pub fn booked_model(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

/// A git worktree a pane worked in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub repo: String,
}

/// The KeepDeck team a pane was on when its calls were booked: the team's id,
/// its name at the time — a renamed or disbanded team still reads as what it
/// was called when the money was spent — and the pane's role on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPlace {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// Where usage happened: the deck's facts about the pane, read back whole and
/// never queried.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_cwd: String,
    pub pane_id: String,
    pub pane_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    /// Absent for a pane on no team, and in every place stored before teams
    /// were recorded — which read back unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<TeamPlace>,
}

/// Calls one pane reported for one session, to book together.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallBatch {
    pub agent: String,
    pub session_id: String,
    /// When KeepDeck's session binding accepted this session for the pane
    /// (unix ms, the deck's clock). Usage older than the first time the deck
    /// saw a session is not booked: it is a fork's copy, or history from
    /// before KeepDeck watched.
    pub first_seen: f64,
    pub place: Place,
    pub calls: Vec<UsageCall>,
}

/// One row of the ledger as the webview reads it: either one booked event
/// (`count` 1) or a compacted bucket of a session's events. Its fields are an
/// event's, so every derivation reads both alike.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub event_id: String,
    pub occurred_at: f64,
    pub captured_at: f64,
    pub agent: String,
    /// The booked `<provider>/<model>` key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The catalogue's name for the model, when it knows the model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_cwd: String,
    pub pane_id: String,
    pub pane_name: String,
    pub session_id: String,
    pub root_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<TeamPlace>,
    pub tokens: TokenCounts,
    /// Priced from the journal as the row is served; absent when unpriced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// What the row's cache reads saved against fresh input, at the same
    /// price — an estimate; absent when unpriced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_usd: Option<f64>,
    pub cost_basis: CostBasis,
    pub count: u32,
    pub calls: u32,
}
