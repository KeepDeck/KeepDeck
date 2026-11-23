//! What TS sees of the machine: one snapshot of its state — the phases, the
//! actions each team allows, «forgotten» and the commands owed to the owners.
//! There is no second channel: a command is in the snapshot until its owner
//! answers, a deck command until it is durable or rejected.

use super::{capture, Forgotten, Kind, State, TearPhase};
use crate::domain::command::{Cmd, Owner};
use crate::domain::ids::{CommandId, PaneId, TeamId, WorkspaceId};
use crate::domain::model::{Refusal, Teardown};
use crate::domain::world::TeamAt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum WorkspacePhase {
    Live,
    Closing,
    Archiving,
    Archived,
    Restoring,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum TeamPhase {
    Creating,
    Failed,
    Live,
    /// A Close has it: its sessions are being stopped.
    Leaving,
    /// Its folders are being removed.
    TearingDown,
    /// A cleanup step failed; the next launch retries it.
    Owed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum PanePhase {
    Live,
    Leaving,
    Restarting,
    Suspending,
    Suspended,
}

/// What a team allows now: for each of its actions, the refusal its intent
/// would meet — none when it would go. The intents' own rules, so an offer
/// and its answer cannot disagree; TS only words them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub struct TeamGates {
    pub add_member: Option<Refusal>,
    pub close: Option<Refusal>,
    pub retry: Option<Refusal>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub struct Snapshot {
    /// The barrier is down.
    pub open: bool,
    /// Another KeepDeck holds this settings folder, or the deck could not be
    /// loaded for work: only shows.
    pub view_only: bool,
    pub sessions_down: bool,
    pub forgotten: Forgotten,
    pub workspaces: BTreeMap<WorkspaceId, WorkspacePhase>,
    pub teams: BTreeMap<TeamId, TeamPhase>,
    pub gates: BTreeMap<TeamId, TeamGates>,
    pub panes: BTreeMap<PaneId, PanePhase>,
    /// Commands owed to owners, in order.
    pub commands: Vec<Due>,
}

/// A command due to its owner, the owner named — so TS routes by it and
/// keeps no copy of which owner carries out which command.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Due {
    pub id: CommandId,
    pub owner: Owner,
    pub cmd: Cmd,
}

/// A snapshot with the version of the state it was read from — TS keeps the
/// higher one, within one machine's life.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Versioned {
    #[ts(type = "number")]
    pub version: u64,
    pub snapshot: Snapshot,
}

/// What the page hears on its one channel: each snapshot of the machine it
/// listens to, and last — once — that this machine stopped. A stopped
/// machine is not started again: nothing starts or closes until KeepDeck
/// restarts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Heard {
    Snapshot { versioned: Box<Versioned> },
    Stopped,
}

pub fn snapshot(state: &State) -> Snapshot {
    let mut workspaces = BTreeMap::new();
    for (id, ws) in &state.world.workspaces {
        let phase = if capture::workspace_leaving(state, id) {
            WorkspacePhase::Closing
        } else if capture::archiving(state, id) {
            WorkspacePhase::Archiving
        } else if state.ops.values().any(|op| &op.workspace == id && matches!(op.kind, Kind::Restore)) {
            WorkspacePhase::Restoring
        } else if ws.archived {
            WorkspacePhase::Archived
        } else {
            WorkspacePhase::Live
        };
        workspaces.insert(id.clone(), phase);
    }
    let mut teams = BTreeMap::new();
    let mut gates = BTreeMap::new();
    for (id, team) in &state.world.teams {
        let closing = state.ops.values().find(|op| op.closing() && op.scope().teams.contains(id) || (op.closing() && op.scope().workspace.as_ref() == Some(&team.workspace)));
        let phase = match closing.and_then(|op| op.teardown().map(|t| (op.owed, t.phase))) {
            Some((true, _)) => TeamPhase::Owed,
            Some((false, TearPhase::Reading | TearPhase::Cleaning)) => TeamPhase::TearingDown,
            Some(_) => TeamPhase::Leaving,
            None => match &team.at {
                TeamAt::Creating { .. } => TeamPhase::Creating,
                TeamAt::Failed { .. } => TeamPhase::Failed,
                TeamAt::Attached { .. } | TeamAt::Unplaced => TeamPhase::Live,
            },
        };
        // The barrier first, as every intent meets it.
        let gate = |refusal: Option<Refusal>| if state.open() { refusal } else { Some(Refusal::BarrierUp) };
        gates.insert(
            id.clone(),
            TeamGates {
                add_member: gate(capture::landing_blocked(state, &team.workspace, id)),
                close: gate(capture::disband_blocked(state, &team.workspace, id)),
                retry: gate(capture::retry_blocked(state, &team.workspace, id)),
            },
        );
        teams.insert(id.clone(), phase);
    }
    let mut panes = BTreeMap::new();
    for (&id, pane) in &state.world.panes {
        let holder = state.ops.values().find_map(|op| op.teardown().filter(|t| t.panes.contains(&id)).map(|t| t.kind));
        let phase = match holder {
            Some(Teardown::Restart) => PanePhase::Restarting,
            Some(Teardown::Suspend) => PanePhase::Suspending,
            Some(Teardown::Archive) | None if pane.suspended => PanePhase::Suspended,
            Some(Teardown::Archive) | None => PanePhase::Live,
            Some(_) => PanePhase::Leaving,
        };
        panes.insert(id, phase);
    }
    let saved = state.saved;
    let mut commands = Vec::new();
    for (&op_id, op) in &state.ops {
        for (index, sent) in op.sent.iter().enumerate() {
            // A forgetting restored from the journal into a launch whose deck
            // did not load for work stays owed: kept, under its id, and not
            // handed to its owner until a launch that reads the deck whole.
            if sent.cmd.forgets() && !state.boot.cleans() {
                continue;
            }
            if !sent.settled(saved) && !matches!(sent.outcome, Some(crate::domain::command::Outcome::Rejected { .. })) {
                let id = CommandId { op: op_id, index: index as u32 };
                commands.push(Due { id, owner: sent.cmd.owner(), cmd: sent.cmd.clone() });
            }
        }
    }
    Snapshot {
        open: state.open(),
        view_only: !state.open() && !matches!(state.boot, super::boot::Boot::Waiting { .. }),
        sessions_down: state.sessions_down,
        forgotten: state.forgotten.clone(),
        workspaces,
        teams,
        gates,
        panes,
        commands,
    }
}
