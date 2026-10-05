//! The shapes that cross the store's boundary — what a board looks like
//! when it is loaded, and what a change to the boards looks like when it
//! is applied. They are the WIRE form: the TS boundary narrows them into
//! the domain's types and validates them there (the one board validator),
//! so every word of a vocabulary (a status, a priority, a relation kind, a
//! log field) is a plain string here. A value a newer build wrote is
//! carried, never refused by this store: refusing it is the domain's call.
//!
//! The TS side of these types is GENERATED from this file (`ts-rs`); a
//! hand-written copy would be the two-language drift the design rules
//! forbid. Every integer is a JS `number` on the wire.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One board as stored: the tasks in board order, the links whose `from`
/// end is on it, its counter and the number of its latest change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredBoard {
    /// The board's own id — never a workspace id, which is reused.
    pub board: String,
    /// The workspace this board belongs to; none for an unattached board.
    pub workspace: Option<String>,
    #[ts(type = "number")]
    pub next_id: i64,
    /// The number of the board's latest change; 0 for a board never written.
    #[ts(type = "number")]
    pub rev: i64,
    pub tasks: Vec<StoredTask>,
    pub relations: Vec<StoredRelation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredTask {
    pub uid: String,
    /// Its current address on this board (`task-N`).
    pub key: String,
    /// Addresses it had before — on this board or another — that still
    /// lead to it.
    pub old_keys: Vec<StoredKey>,
    pub team_id: Option<String>,
    pub title: String,
    pub body: String,
    /// The number of the brief's current version.
    #[ts(type = "number")]
    pub body_v: i64,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub author: String,
    #[ts(type = "number")]
    pub created: i64,
    #[ts(type = "number")]
    pub updated: i64,
    /// The board change that last touched this task.
    #[ts(type = "number")]
    pub rev: i64,
    pub labels: Vec<String>,
    /// In their order on the task.
    pub artifacts: Vec<String>,
    pub comments: Vec<StoredComment>,
    pub log: Vec<StoredLogEntry>,
    /// Earlier versions of the brief, oldest first; the current one is `body`.
    pub briefs: Vec<StoredBrief>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredKey {
    pub board: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredComment {
    #[ts(type = "number")]
    pub n: i64,
    #[ts(type = "number")]
    pub at: i64,
    pub author: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredLogEntry {
    /// Its place in the task's whole log, from 0.
    #[ts(type = "number")]
    pub seq: i64,
    #[ts(type = "number")]
    pub at: i64,
    pub author: String,
    pub field: String,
    pub was: Option<String>,
    pub now: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredBrief {
    #[ts(type = "number")]
    pub v: i64,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct StoredRelation {
    pub kind: String,
    pub from: String,
    pub to: String,
    #[ts(type = "number")]
    pub at: i64,
    pub by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct RelationKey {
    pub kind: String,
    pub from: String,
    pub to: String,
}

/// One change to the boards, applied as ONE transaction: every board it
/// touches moves together or not at all. `request_id` makes it safe to
/// send again — a change already applied answers so, and is not applied
/// twice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct ChangeSet {
    pub request_id: String,
    pub boards: Vec<BoardChange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct BoardChange {
    pub board: String,
    /// The workspace a board being created belongs to; must match an
    /// existing board's.
    pub workspace: Option<String>,
    /// The board's rev the change was computed against; 0 for a new board.
    #[ts(type = "number")]
    pub expected_rev: i64,
    /// Never less than the stored counter.
    #[ts(type = "number")]
    pub next_id: i64,
    /// Tasks written in full: new ones, changed ones, and ones arriving
    /// from another board.
    pub tasks: Vec<TaskWrite>,
    /// Tasks that left the boards altogether (a disbanded team's).
    pub removed: Vec<String>,
    pub relations_put: Vec<StoredRelation>,
    pub relations_removed: Vec<RelationKey>,
}

/// A task as written. Its scalar fields replace the stored ones; `labels`
/// and `artifacts` replace theirs when present; comments, log entries and
/// brief versions are APPENDED — the store never deletes one, and one sent
/// again exactly as stored is no change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct TaskWrite {
    pub uid: String,
    #[ts(type = "number")]
    pub board_pos: i64,
    pub team_id: Option<String>,
    pub title: String,
    pub body: String,
    #[ts(type = "number")]
    pub body_v: i64,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub author: String,
    #[ts(type = "number")]
    pub created: i64,
    #[ts(type = "number")]
    pub updated: i64,
    /// A new current address on this board: a new task's, or a moved one's.
    pub key: Option<String>,
    pub labels: Option<Vec<String>>,
    pub artifacts: Option<Vec<String>>,
    pub comments: Vec<StoredComment>,
    pub log: Vec<StoredLogEntry>,
    pub briefs: Vec<StoredBrief>,
}

/// How an applied change went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export, export_to = "tasks/")]
pub enum Applied {
    /// Applied now; the boards' new revs.
    Applied { revs: Vec<BoardRev> },
    /// This request was applied before (its answer was lost); its revs then.
    AlreadyApplied { revs: Vec<BoardRev> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct BoardRev {
    pub board: String,
    #[ts(type = "number")]
    pub rev: i64,
}

/// One search hit, best first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "tasks/")]
pub struct SearchHit {
    pub uid: String,
    pub board: String,
    /// Where it matched: the task itself, or one of its comments (`n`).
    #[ts(type = "number | null")]
    pub comment: Option<i64>,
    /// The match in context, with `[` `]` around the matched words.
    pub snippet: String,
}
