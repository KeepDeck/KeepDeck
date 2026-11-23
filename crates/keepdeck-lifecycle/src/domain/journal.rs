//! The journal of unfinished work: one entry per operation with a step that
//! cannot be taken back, on disk before that step, removed once every step is
//! done and its last deck command is saved. Empty in normal running.
//!
//! An entry is self-sufficient: the tail of its operation needs nothing else —
//! not the deck, not the sessions of the launch that wrote it. This module
//! holds what an entry says; its file, its format and how boot reads it back
//! are the infrastructure's ([`crate::infrastructure::journal`]).

use super::command::{Command, Why};
use super::dir::Dir;
use super::ids::{OpId, PaneId, TeamId, WorkspaceId};
use super::model::{Consent, SessionKey};
use serde::{Deserialize, Serialize};

/// The worktree a creation makes: written before `git worktree add`, so a
/// checkout found there after a crash is this ticket's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub repo: Dir,
    pub path: Dir,
    pub branch: String,
    pub base: Option<String>,
}

/// What a Close ends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Agent { pane: PaneId },
    Team { team: TeamId },
    Workspace,
}

/// The plan for removing one worktree, written before its first step: the
/// checkout, and the branches born in it — read from its reflog, which git
/// erases with the checkout. Whether a branch is still somebody's is git's
/// word at the moment of its deletion, not the plan's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Removal {
    pub repo: Dir,
    pub path: Dir,
    pub branches: Vec<String>,
}

/// One step of an operation's tail that is done. What is not done yet is the
/// plan minus these; a failed step stays undone and is retried at every launch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    Checkout { path: Dir },
    Branch { repo: Dir, name: String },
    /// The plantings taken out of a folder.
    Disarm { dir: Dir },
    /// The workspace's data in the stores of Rust removed.
    Stores,
    /// A folder's HEAD kept as the tag `name` before it goes.
    Tag { path: Dir, name: String },
    /// The fork's scaffolding removed.
    Discard,
}

/// What a fork's hook said to remove when its fork does not finish. Paths of
/// the plugin's own store, removed as the plugin: no launch arguments, no
/// secrets.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub struct Discard {
    pub plugin: String,
    /// What is removed once the launch is bound, and on any rollback.
    pub once_started: Vec<String>,
    /// What is removed only by a rollback: the copy itself.
    pub if_never_started: Vec<String>,
}

/// The operation an entry keeps, with its frozen inputs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Work {
    /// A team whose worktree a ticket creates — a creation, its Retry.
    Create { team: TeamId, ticket: Ticket },
    /// A Close, with its membership as final as the ops before it left it.
    Close {
        target: Target,
        teams: Vec<TeamId>,
        panes: Vec<PaneId>,
        consent: Consent,
        removals: Vec<Removal>,
        /// The repository its branch names are unique within: what they are
        /// held against while its cleanup is owed, its workspace gone or not.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space: Option<Dir>,
    },
    Archive { panes: Vec<PaneId> },
    /// The repository is the one taken when it was accepted: it needs no
    /// workspace row to finish. Absent only from an entry written before.
    RemoveUnheld {
        path: Dir,
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<Dir>,
        /// The person agreed to lose its uncommitted work. An entry written
        /// before this was kept reads as not: a dirty checkout then stays.
        #[serde(default)]
        discard: bool,
    },
    /// A conversation carried into a new pane. Open until the pane's launch is
    /// bound to it: an open fork at boot did not finish, and is rolled back.
    Fork {
        pane: PaneId,
        source: SessionKey,
        /// The team made for the fork, if it made one.
        team: Option<TeamId>,
        ticket: Option<Ticket>,
        /// Known once the hook's result is accepted.
        discard: Option<Discard>,
    },
}

/// The commands to data owners an operation's tail needs, with whether each
/// is settled (a deck command: durable or rejected) — and, for one its owner
/// refused, the owner's reason, so a restore does not take a refusal for an
/// application.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    pub command: Command,
    pub settled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<Why>,
}

/// One operation's entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub op: OpId,
    pub workspace: WorkspaceId,
    pub work: Work,
    /// Operations this one joined and waits for — a workspace close that
    /// joined a disband already under way names it here before its first
    /// step.
    #[serde(default)]
    pub joined: Vec<OpId>,
    #[serde(default)]
    pub commands: Vec<Sent>,
    #[serde(default)]
    pub done: Vec<Step>,
}
