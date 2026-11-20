//! Who goes first: the arbiter's captures, read off the operations under way,
//! and the acceptance of an intent.
//!
//! Exclusive operations hold their pane, team, workspace or folder; whoever
//! took it first leads, and the next gets «already closing» or «busy». A
//! Close may take over a creation and an archive; a workspace close joins a
//! disband under way, a disband a member's close. Additive operations go one
//! after another and are refused only when their target is leaving or
//! archived.

use super::create::{self, Seat};
use super::queries;
use super::teardown::{self, Teardown, Unheld};
use super::{answer_op, Fx, Kind, Op, Session, State};
use crate::dir::Dir;
use crate::ids::{AskId, OpId, PaneId, TeamId, WorkspaceId};
use crate::model::{self, Answer, Continuation, Intent, Landing, Minted, Refusal, Site};
use crate::world::{TeamAt, Workspace};
use std::collections::BTreeSet;

/// What an exclusive operation holds.
#[derive(Default)]
pub struct Scope {
    pub workspace: Option<WorkspaceId>,
    pub teams: BTreeSet<TeamId>,
    pub panes: BTreeSet<PaneId>,
    pub folders: BTreeSet<Dir>,
}

impl Op {
    /// What this operation holds — nothing for an additive one.
    pub fn scope(&self) -> Scope {
        let mut scope = Scope::default();
        match &self.kind {
            Kind::Teardown(teardown) => {
                if teardown.whole_workspace() {
                    scope.workspace = Some(self.workspace.clone());
                }
                scope.teams.extend(teardown.teams.iter().cloned());
                scope.panes.extend(teardown.panes.iter().copied());
                scope.folders.extend(teardown.deleting());
            }
            Kind::Create(create) => {
                scope.teams.insert(create.team.clone());
                scope.panes.extend(create.members.iter().map(|member| member.pane));
            }
            Kind::CreateWorkspace | Kind::Restore => scope.workspace = Some(self.workspace.clone()),
            Kind::RemoveUnheld(unheld) => {
                scope.folders.insert(unheld.path.clone());
            }
            Kind::Seat(_) | Kind::Fork(_) | Kind::Relocate(_) | Kind::Resume { .. } | Kind::Reconcile(_) => {}
        }
        scope
    }

    /// A Close of a pane, a team or a workspace.
    pub fn closing(&self) -> bool {
        matches!(&self.kind, Kind::Teardown(teardown) if teardown.is_close())
    }
}

impl State {
    /// The operations whose scope takes this pane, directly or through its
    /// team or workspace.
    fn holders_of_pane(&self, pane: &PaneId) -> Vec<OpId> {
        let row = self.world.panes.get(pane);
        self.ops
            .iter()
            .filter(|(_, op)| {
                let scope = op.scope();
                scope.panes.contains(pane)
                    || row.is_some_and(|row| {
                        scope.workspace.as_ref() == Some(&row.workspace)
                            || row.team.as_ref().is_some_and(|team| scope.teams.contains(team))
                    })
            })
            .map(|(&id, _)| id)
            .collect()
    }

    fn holders_of_team(&self, team: &TeamId) -> Vec<OpId> {
        let workspace = self.world.teams.get(team).map(|row| row.workspace.clone());
        self.ops
            .iter()
            .filter(|(_, op)| {
                let scope = op.scope();
                scope.teams.contains(team) || (workspace.is_some() && scope.workspace == workspace)
            })
            .map(|(&id, _)| id)
            .collect()
    }

    fn holders_of_workspace(&self, workspace: &WorkspaceId) -> Vec<OpId> {
        self.ops.iter().filter(|(_, op)| &op.workspace == workspace && !op.scope().is_empty()).map(|(&id, _)| id).collect()
    }
}

impl Scope {
    fn is_empty(&self) -> bool {
        self.workspace.is_none() && self.teams.is_empty() && self.panes.is_empty() && self.folders.is_empty()
    }
}

/// The refusal an exclusive intent meets from the operations already holding
/// its objects: «already closing» when one of them is a Close.
fn conflict(state: &State, holders: &[OpId]) -> Option<Refusal> {
    if holders.is_empty() {
        return None;
    }
    if holders.iter().any(|id| state.ops[id].closing()) {
        Some(Refusal::AlreadyClosing)
    } else {
        Some(Refusal::Busy)
    }
}

pub fn archiving(state: &State, workspace: &WorkspaceId) -> bool {
    state.ops.values().any(|op| &op.workspace == workspace && matches!(&op.kind, Kind::Teardown(t) if t.kind == model::Teardown::Archive))
}

pub fn workspace_leaving(state: &State, workspace: &WorkspaceId) -> bool {
    state.forgotten.workspaces.contains(workspace)
        || state.ops.values().any(|op| op.closing() && op.scope().workspace.as_ref() == Some(workspace))
}

pub fn team_leaving(state: &State, team: &TeamId) -> bool {
    state.forgotten.teams.contains(team)
        || state.world.teams.get(team).is_some_and(|row| workspace_leaving(state, &row.workspace))
        || state.ops.values().any(|op| op.closing() && op.scope().teams.contains(team))
}

pub fn folder_leaving(state: &State, dir: &Dir) -> bool {
    state.ops.values().any(|op| op.scope().folders.contains(dir))
}

/// The pane is held by an exclusive operation, or its team or workspace is.
pub fn pane_taken(state: &State, pane: &PaneId) -> bool {
    !state.holders_of_pane(pane).is_empty()
}

/// A teardown under way covers this session: it stops it when its steps say so.
pub fn session_in_teardown(state: &State, session: &Session) -> bool {
    state.ops.values().any(|op| matches!(&op.kind, Kind::Teardown(teardown) if teardown.covers(op, session)))
}

/// The additive operations begun before `before` that change the membership
/// of `teams` (or of any team, for a whole workspace) and have not ended.
pub fn additive_in_flight(state: &State, before: OpId, workspace: &WorkspaceId, teams: &BTreeSet<TeamId>, whole: bool) -> bool {
    state.ops.range(..before).any(|(_, op)| {
        &op.workspace == workspace
            && create::membership_pending(op, state.saved)
            && (whole || create::touched_teams(op).iter().any(|team| teams.contains(team)))
    })
}

fn refuse(fx: &mut Fx, ask: AskId, refusal: Refusal) {
    fx.answer(ask, Answer::refused(refusal));
}

/// The workspace is archived, or an archive of it is under way: nothing new
/// is made or started in it.
fn shelved(state: &State, workspace: &WorkspaceId) -> bool {
    archiving(state, workspace) || state.world.workspaces.get(workspace).is_some_and(|ws| ws.archived)
}

fn team_in(state: &State, workspace: &WorkspaceId, team: &TeamId) -> bool {
    state.world.teams.get(team).is_some_and(|row| &row.workspace == workspace)
}

/// Why an additive operation may not land on `team`, if it may not. The
/// snapshot's add-member gate reads the same rule.
pub fn landing_blocked(state: &State, workspace: &WorkspaceId, team: &TeamId) -> Option<Refusal> {
    if !team_in(state, workspace, team) {
        return Some(Refusal::NotFound);
    }
    if shelved(state, workspace) {
        return Some(Refusal::Archived);
    }
    if team_leaving(state, team) {
        return Some(Refusal::TargetLeaving);
    }
    None
}

/// Why a Retry of `team`'s creation would be refused now, if it would. The
/// snapshot's retry gate reads the same rule.
pub fn retry_blocked(state: &State, workspace: &WorkspaceId, team: &TeamId) -> Option<Refusal> {
    if !team_in(state, workspace, team) || !matches!(state.world.teams[team].at, TeamAt::Failed { .. }) {
        return Some(Refusal::NotFound);
    }
    if shelved(state, workspace) {
        return Some(Refusal::Archived);
    }
    conflict(state, &state.holders_of_team(team))
}

/// The operations holding `team`, split into what a Disband joins — its
/// members' own closes — and what it meets.
fn disband_holders(state: &State, team: &TeamId) -> (Vec<OpId>, Vec<OpId>) {
    state
        .holders_of_team(team)
        .into_iter()
        .partition(|id| matches!(&state.ops[id].kind, Kind::Teardown(t) if t.kind == model::Teardown::CloseAgent))
}

/// Why a Disband of `team` would be refused now, if it would. The
/// snapshot's close gate reads the same rule.
pub fn disband_blocked(state: &State, workspace: &WorkspaceId, team: &TeamId) -> Option<Refusal> {
    if !team_in(state, workspace, team) {
        return Some(Refusal::NotFound);
    }
    close_conflict(state, &disband_holders(state, team).1)
}

fn id_taken(state: &State, team: &TeamId) -> bool {
    state.world.teams.contains_key(team) || state.forgotten.teams.contains(team)
}

pub fn intent(state: &mut State, ask: AskId, intent: Intent, fx: &mut Fx) {
    if !state.open() {
        return refuse(fx, ask, Refusal::BarrierUp);
    }
    let workspace = intent.workspace().clone();
    let known = state.world.workspaces.contains_key(&workspace);
    if !known && !matches!(intent, Intent::CreateWorkspace { .. }) {
        return refuse(fx, ask, Refusal::NotFound);
    }
    let journaled = intent.journaled();
    match intent {
        Intent::CreateWorkspace { workspace, name, cwd, worktree_base, draft } => {
            if known || state.forgotten.workspaces.contains(&workspace) || !state.holders_of_workspace(&workspace).is_empty() {
                return refuse(fx, ask, Refusal::Busy);
            }
            state.world.workspaces.insert(workspace.clone(), Workspace { name, cwd, base: worktree_base, archived: false });
            let id = state.mint_op();
            let mut op = Op::new(workspace.clone(), ask, false, Kind::CreateWorkspace);
            op.send(crate::command::Cmd::AddWorkspace { workspace, draft });
            state.ops.insert(id, op);
        }
        Intent::Describe { workspace, name, worktree_base } => {
            let ws = state.world.workspaces.get_mut(&workspace).expect("known");
            ws.name = name;
            ws.base = worktree_base;
            let op = state.mint_op();
            fx.answer(ask, Answer::Accepted { op, minted: Minted::default() });
        }
        Intent::CreateTeam { workspace, team, site, draft, members } => {
            if id_taken(state, &team) {
                return refuse(fx, ask, Refusal::Busy);
            }
            if let Some(refusal) = workspace_blocked(state, &workspace) {
                return refuse(fx, ask, refusal);
            }
            let members = members.into_iter().map(|draft| crate::command::Member { pane: state.mint_pane(), draft }).collect();
            let create = create::Create::new(team, draft, site, members, None, false);
            let id = state.mint_op();
            state.ops.insert(id, Op::new(workspace, ask, journaled, Kind::Create(Box::new(create))));
        }
        Intent::Retry { workspace, team } => {
            if let Some(refusal) = retry_blocked(state, &workspace, &team) {
                return refuse(fx, ask, refusal);
            }
            let TeamAt::Failed { ticket, .. } = state.world.teams[&team].at.clone() else {
                return refuse(fx, ask, Refusal::NotFound);
            };
            let id = state.mint_op();
            let create = create::Create::retry(team, ticket);
            state.ops.insert(id, Op::new(workspace, ask, true, Kind::Create(Box::new(create))));
        }
        Intent::Seat { workspace, team, member } => {
            if let Some(refusal) = landing_blocked(state, &workspace, &team) {
                return refuse(fx, ask, refusal);
            }
            let pane = state.mint_pane();
            let id = state.mint_op();
            state.ops.insert(id, Op::new(workspace, ask, false, Kind::Seat(Seat::new(team, pane, member, None))));
        }
        Intent::Continue { workspace, landing, source, how, member } => {
            let reserved = state.ops.values().any(|op| create::reserves(op) == Some(&source));
            if how == Continuation::Resume && reserved {
                return refuse(fx, ask, Refusal::Busy);
            }
            let pane = state.mint_pane();
            let id = state.mint_op();
            let kind = match (how, landing) {
                (Continuation::Resume, Landing::Team { team }) => {
                    if let Some(refusal) = landing_blocked(state, &workspace, &team) {
                        return refuse(fx, ask, refusal);
                    }
                    Kind::Seat(Seat::new(team, pane, member, Some(source)))
                }
                (Continuation::Resume, Landing::NewTeam { team, site, draft }) => {
                    if id_taken(state, &team) {
                        return refuse(fx, ask, Refusal::Busy);
                    }
                    if let Some(refusal) = workspace_blocked(state, &workspace) {
                        return refuse(fx, ask, refusal);
                    }
                    let members = vec![crate::command::Member { pane, draft: member }];
                    let journaled = matches!(site, Site::New { .. });
                    let create = create::Create::new(team, draft, site, members, Some(source), false);
                    state.ops.insert(id, Op::new(workspace, ask, journaled, Kind::Create(Box::new(create))));
                    return;
                }
                (Continuation::Fork, landing) => {
                    let new_team = match &landing {
                        Landing::Team { team } => {
                            if let Some(refusal) = landing_blocked(state, &workspace, team) {
                                return refuse(fx, ask, refusal);
                            }
                            None
                        }
                        Landing::NewTeam { team, site, draft } => {
                            if id_taken(state, team) {
                                return refuse(fx, ask, Refusal::Busy);
                            }
                            if let Some(refusal) = workspace_blocked(state, &workspace) {
                                return refuse(fx, ask, refusal);
                            }
                            Some(create::Create::new(team.clone(), draft.clone(), site.clone(), Vec::new(), None, true))
                        }
                    };
                    let team = match &landing {
                        Landing::Team { team } | Landing::NewTeam { team, .. } => team.clone(),
                    };
                    Kind::Fork(Box::new(create::Fork::new(team, pane, member, source, new_team)))
                }
            };
            state.ops.insert(id, Op::new(workspace, ask, journaled, kind));
        }
        Intent::Relocate { workspace, pane, root, role } => {
            let Some(row) = state.world.panes.get(&pane).filter(|row| row.workspace == workspace) else {
                return refuse(fx, ask, Refusal::NotFound);
            };
            if let Some(refusal) = conflict(state, &state.holders_of_pane(&pane)) {
                return refuse(fx, ask, refusal);
            }
            let from = row.team.clone();
            let ws_cwd = state.world.workspaces[&workspace].cwd.clone();
            let existing_root = state
                .world
                .teams
                .iter()
                .find(|(_, team)| team.workspace == workspace && matches!(&team.at, TeamAt::Attached { cwd, .. } if *cwd == ws_cwd))
                .map(|(id, _)| id.clone());
            if existing_root.is_none() && id_taken(state, &root) {
                return refuse(fx, ask, Refusal::Busy);
            }
            if let Some(refusal) = existing_root.as_ref().and_then(|team| landing_blocked(state, &workspace, team)) {
                return refuse(fx, ask, refusal);
            }
            let relocate = create::Relocate::new(pane, from, existing_root.clone().unwrap_or(root), existing_root.is_none(), role);
            let id = state.mint_op();
            state.ops.insert(id, Op::new(workspace, ask, false, Kind::Relocate(relocate)));
        }
        Intent::CloseAgent { workspace, pane, consent } => {
            let Some(row) = state.world.panes.get(&pane).filter(|row| row.workspace == workspace) else {
                return refuse(fx, ask, Refusal::NotFound);
            };
            let _ = row;
            let holders = state.holders_of_pane(&pane);
            if let Some(refusal) = close_conflict(state, &holders) {
                return refuse(fx, ask, refusal);
            }
            // One pane's close holds that pane only: its team goes on.
            let teardown = Teardown::new(model::Teardown::CloseAgent, crate::journal::Target::Agent { pane }, Vec::new(), vec![pane], consent);
            open_teardown(state, ask, workspace, teardown, holders, journaled);
        }
        Intent::Disband { workspace, team, consent } => {
            if let Some(refusal) = disband_blocked(state, &workspace, &team) {
                return refuse(fx, ask, refusal);
            }
            // Held to what its dialog showed: a member seated or moved in since
            // is asked about again.
            if queries::disband_offer(state, &workspace, &team).outgrows(&consent) {
                return refuse(fx, ask, Refusal::Changed);
            }
            // A member's close under way is joined, not refused.
            let (joinable, blocking) = disband_holders(state, &team);
            let mut teardown = Teardown::new(model::Teardown::Disband, crate::journal::Target::Team { team: team.clone() }, vec![team], Vec::new(), consent);
            teardown.joined = joinable;
            open_teardown(state, ask, workspace, teardown, blocking, journaled);
        }
        Intent::CloseWorkspace { workspace, consent } => {
            let holders = state.holders_of_workspace(&workspace);
            let joinable: Vec<OpId> = holders
                .iter()
                .copied()
                .filter(|id| matches!(&state.ops[id].kind, Kind::Teardown(t) if matches!(t.kind, model::Teardown::Disband | model::Teardown::CloseAgent)))
                .collect();
            let blocking: Vec<OpId> = holders.iter().copied().filter(|id| !joinable.contains(id)).collect();
            if let Some(refusal) = close_conflict(state, &blocking) {
                return refuse(fx, ask, refusal);
            }
            if queries::close_workspace_offer(state, &workspace).outgrows(&consent) {
                return refuse(fx, ask, Refusal::Changed);
            }
            let mut teardown = Teardown::new(model::Teardown::CloseWorkspace, crate::journal::Target::Workspace, Vec::new(), Vec::new(), consent);
            teardown.joined = joinable;
            open_teardown(state, ask, workspace, teardown, blocking, journaled);
        }
        Intent::Archive { workspace } => {
            if state.world.workspaces[&workspace].archived {
                return refuse(fx, ask, Refusal::Archived);
            }
            if let Some(refusal) = conflict(state, &state.holders_of_workspace(&workspace)) {
                return refuse(fx, ask, refusal);
            }
            let teardown = Teardown::new(model::Teardown::Archive, crate::journal::Target::Workspace, Vec::new(), Vec::new(), model::Consent::default());
            open_teardown(state, ask, workspace, teardown, Vec::new(), journaled);
        }
        Intent::Restore { workspace } => {
            if !state.world.workspaces[&workspace].archived {
                return refuse(fx, ask, Refusal::NotFound);
            }
            if let Some(refusal) = conflict(state, &state.holders_of_workspace(&workspace)) {
                return refuse(fx, ask, refusal);
            }
            let id = state.mint_op();
            let mut op = Op::new(workspace.clone(), ask, false, Kind::Restore);
            op.send(crate::command::Cmd::ClearArchived { workspace });
            answer_op(&mut op, fx, Answer::Accepted { op: id, minted: Minted::default() });
            state.ops.insert(id, op);
        }
        Intent::Restart { workspace, pane } => pause(state, ask, workspace, pane, model::Teardown::Restart, fx),
        Intent::Suspend { workspace, pane } => pause(state, ask, workspace, pane, model::Teardown::Suspend, fx),
        Intent::Resume { workspace, pane } => {
            let Some(row) = state.world.panes.get(&pane).filter(|row| row.workspace == workspace) else {
                return refuse(fx, ask, Refusal::NotFound);
            };
            if state.world.workspaces[&workspace].archived {
                return refuse(fx, ask, Refusal::Archived);
            }
            if !row.suspended {
                return refuse(fx, ask, Refusal::NotFound);
            }
            if let Some(refusal) = conflict(state, &state.holders_of_pane(&pane)) {
                return refuse(fx, ask, refusal);
            }
            let id = state.mint_op();
            let mut op = Op::new(workspace.clone(), ask, false, Kind::Resume { pane });
            op.send(crate::command::Cmd::ClearSuspended { workspace, pane });
            answer_op(&mut op, fx, Answer::Accepted { op: id, minted: Minted::default() });
            state.ops.insert(id, op);
        }
        Intent::RemoveUnheld { workspace, path, tag } => {
            if teardown::folder_held(state, &path, None) {
                return refuse(fx, ask, Refusal::Busy);
            }
            let id = state.mint_op();
            state.ops.insert(id, Op::new(workspace, ask, true, Kind::RemoveUnheld(Unheld::new(path, tag))));
        }
    }
}

/// A restart or a suspend: the pane's exact session stopped quickly, its
/// launch state retired; a suspend also marks the pane.
fn pause(state: &mut State, ask: AskId, workspace: WorkspaceId, pane: PaneId, kind: model::Teardown, fx: &mut Fx) {
    let Some(row) = state.world.panes.get(&pane).filter(|row| row.workspace == workspace) else {
        return refuse(fx, ask, Refusal::NotFound);
    };
    if state.world.workspaces[&workspace].archived {
        return refuse(fx, ask, Refusal::Archived);
    }
    if kind == model::Teardown::Suspend && row.suspended {
        return refuse(fx, ask, Refusal::NotFound);
    }
    if let Some(refusal) = conflict(state, &state.holders_of_pane(&pane)) {
        return refuse(fx, ask, refusal);
    }
    let teardown = Teardown::new(kind, crate::journal::Target::Agent { pane }, Vec::new(), vec![pane], model::Consent::default());
    open_teardown(state, ask, workspace, teardown, Vec::new(), false);
}

/// Why nothing new may be made in this workspace now, if it may not.
fn workspace_blocked(state: &State, workspace: &WorkspaceId) -> Option<Refusal> {
    if shelved(state, workspace) {
        return Some(Refusal::Archived);
    }
    if workspace_leaving(state, workspace) {
        return Some(Refusal::TargetLeaving);
    }
    None
}

/// What a new Close meets: a Close of the same objects; anything exclusive
/// but a creation or an archive, which a Close takes over.
fn close_conflict(state: &State, holders: &[OpId]) -> Option<Refusal> {
    let blocking: Vec<OpId> = holders.iter().copied().filter(|id| !teardown::taken_over_by_close(&state.ops[id])).collect();
    conflict(state, &blocking)
}

fn open_teardown(state: &mut State, ask: AskId, workspace: WorkspaceId, teardown: Teardown, holders: Vec<OpId>, journaled: bool) {
    let id = state.mint_op();
    let mut op = Op::new(workspace, ask, journaled, Kind::Teardown(Box::new(teardown)));
    // A creation or an archive the Close takes over stops where it is.
    for holder in holders {
        if let Some(taken) = state.ops.get_mut(&holder) {
            teardown::abandon(taken, id);
        }
    }
    if let Kind::Teardown(teardown) = &mut op.kind {
        teardown.capture(&state.world, &op.workspace);
    }
    state.ops.insert(id, op);
}
