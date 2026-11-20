//! The one core of every teardown — close an agent, disband a team, close a
//! workspace, archive, restart, suspend. What differs is the operation's own
//! strategy; the steps are the same:
//!
//! queued behind the additive operations begun before it → its entry on disk
//! with the final membership → «forgotten» and «retire» → the deck's rows and
//! the sessions' stops, the admitted launches cancelled at the start boundary
//! → the plan for each folder, on disk before its first step → the steps →
//! the entry removed, or kept as a debt the next launch retries.

use super::launch::{LaunchOwner, Session};
use super::{answer_op, capture, durable, finish, Clean, Effect, Event, Fx, Kind, Op, State, StepResult, Timer};
use super::{LEASE_WAIT, REGISTRATION_WAIT, RETIRE_WAIT};
use crate::command::Cmd;
use crate::dir::Dir;
use crate::ids::{AttemptId, OpId, PaneId, TeamId, WorkspaceId};
use crate::journal::{Removal, Step, Target, Work};
use crate::model::{self, Answer, Consent, Forget, Minted, Rows};
use crate::world::{TeamAt, World};
use keepdeck_fsm::Owed;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TearPhase {
    /// Waiting for the additive operations begun before it to end.
    Queued,
    /// Its entry is being written; the capture is provisional.
    Journaling,
    /// The first write failed: its entry is being taken back.
    RollingBack,
    /// «Retire» is out to the launch state: the secrets end before the process.
    Retiring,
    /// The deck's rows are going and the sessions are being stopped.
    Stopping,
    /// The branches born in each folder are being read for the plan.
    Reading,
    Cleaning,
    /// A Close took it over: it stops where it is.
    Abandoned,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Waited {
    pub retire: bool,
    pub leases: bool,
    pub registration: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Teardown {
    pub kind: model::Teardown,
    pub target: Target,
    /// The teams it ends — none for a single pane's close, a restart, a suspend.
    pub teams: Vec<TeamId>,
    pub panes: Vec<PaneId>,
    pub consent: Consent,
    pub joined: Vec<OpId>,
    pub phase: TearPhase,
    pub removals: Vec<Removal>,
    /// The folders whose plan is still being read.
    pub reading: BTreeSet<Dir>,
    pub plan: Vec<Step>,
    pub done: Vec<Step>,
    pub failed: Vec<Step>,
    /// Admitted launches it took over, waiting for the start boundary's word.
    pub taken: BTreeSet<AttemptId>,
    /// Of those, the ones whose process exists: their sessions are awaited.
    pub started: BTreeSet<AttemptId>,
    pub waited: Waited,
    /// Restored from the journal at boot: no session of a past launch is
    /// waited for.
    pub restored: bool,
}

impl Teardown {
    pub fn new(kind: model::Teardown, target: Target, teams: Vec<TeamId>, panes: Vec<PaneId>, consent: Consent) -> Teardown {
        Teardown {
            kind,
            target,
            teams,
            panes,
            consent,
            joined: Vec::new(),
            phase: TearPhase::Queued,
            removals: Vec::new(),
            reading: BTreeSet::new(),
            plan: Vec::new(),
            done: Vec::new(),
            failed: Vec::new(),
            taken: BTreeSet::new(),
            started: BTreeSet::new(),
            waited: Waited::default(),
            restored: false,
        }
    }

    pub fn whole_workspace(&self) -> bool {
        matches!(self.kind, model::Teardown::CloseWorkspace | model::Teardown::Archive)
    }

    pub fn is_close(&self) -> bool {
        matches!(self.kind, model::Teardown::CloseAgent | model::Teardown::Disband | model::Teardown::CloseWorkspace)
    }

    fn strategy(&self) -> model::Strategy {
        self.kind.strategy()
    }

    /// Who it ends, as the world says now. A team's members and a
    /// workspace's everything are read again when the queue lets it go, so
    /// the membership is the one the additive operations before it left.
    pub fn capture(&mut self, world: &World, workspace: &WorkspaceId) {
        match self.kind {
            model::Teardown::CloseWorkspace | model::Teardown::Archive => {
                self.teams = world.teams_of(workspace);
                self.panes = world.panes_of(workspace);
            }
            model::Teardown::Disband => {
                self.panes = self.teams.iter().flat_map(|team| world.members(team)).collect();
            }
            model::Teardown::CloseAgent | model::Teardown::Restart | model::Teardown::Suspend => {}
        }
    }

    /// The folders it may delete.
    pub fn deleting(&self) -> Vec<Dir> {
        self.consent.folders.iter().map(|folder| folder.path.clone()).collect()
    }

    /// This session is in its scope.
    pub fn covers(&self, op: &Op, session: &Session) -> bool {
        if self.phase == TearPhase::Abandoned {
            return false;
        }
        let pane = session.owner.pane().is_some_and(|pane| self.panes.contains(&pane));
        let workspace = self.whole_workspace() && session.workspace.as_ref() == Some(&op.workspace);
        let folder = session.dir.as_ref().is_some_and(|dir| self.consent.folders.iter().any(|folder| &folder.path == dir));
        pane || workspace || folder
    }

    /// The entry it keeps on disk, once its membership is final.
    pub fn journaled(&self) -> Option<Work> {
        if matches!(self.phase, TearPhase::Queued | TearPhase::Abandoned) {
            return None;
        }
        match self.kind {
            model::Teardown::Restart | model::Teardown::Suspend => None,
            model::Teardown::Archive => Some(Work::Archive { panes: self.panes.clone() }),
            model::Teardown::CloseAgent | model::Teardown::Disband | model::Teardown::CloseWorkspace => Some(Work::Close {
                target: self.target.clone(),
                teams: self.teams.clone(),
                panes: self.panes.clone(),
                consent: self.consent.clone(),
                removals: self.removals.clone(),
            }),
        }
    }

    fn journals(&self) -> bool {
        !matches!(self.kind, model::Teardown::Restart | model::Teardown::Suspend)
    }
}

/// A creation or an archive a Close may take over.
pub fn taken_over_by_close(op: &Op) -> bool {
    match &op.kind {
        Kind::Create(_) => true,
        Kind::Teardown(teardown) => teardown.kind == model::Teardown::Archive,
        _ => false,
    }
}

/// A Close took this operation over.
pub fn abandon(op: &mut Op, _by: OpId) {
    match &mut op.kind {
        Kind::Create(create) => create.abandon(),
        Kind::Teardown(teardown) if teardown.kind == model::Teardown::Archive => teardown.phase = TearPhase::Abandoned,
        _ => {}
    }
}

/// Whether anyone but `except` holds this folder: a team placed there, a
/// live session in it, a creation's ticket or candidate, another
/// operation's deletion.
pub fn folder_held(state: &State, dir: &Dir, except: Option<OpId>) -> bool {
    let leaving: BTreeSet<TeamId> = except
        .and_then(|id| state.ops.get(&id))
        .map(|op| op.scope().teams.into_iter().collect())
        .unwrap_or_default();
    let teams = state.world.teams.iter().any(|(id, team)| {
        !leaving.contains(id)
            && match &team.at {
                TeamAt::Attached { cwd, .. } => cwd == dir,
                TeamAt::Creating { ticket, .. } | TeamAt::Failed { ticket, .. } => &ticket.path == dir,
                TeamAt::Unplaced => false,
            }
    });
    let sessions = state.sessions.values().any(|session| {
        !session.ended
            && session.dir.as_ref() == Some(dir)
            && !except.and_then(|id| state.ops.get(&id)).is_some_and(|op| matches!(&op.kind, Kind::Teardown(t) if t.covers(op, session)))
    });
    let ops = state.ops.iter().any(|(&id, op)| {
        Some(id) != except && (op.scope().folders.contains(dir) || super::create::holds_folder(op, dir))
    });
    teams || sessions || ops
}

impl Op {
    pub fn teardown(&self) -> Option<&Teardown> {
        match &self.kind {
            Kind::Teardown(teardown) => Some(teardown),
            _ => None,
        }
    }

    pub fn teardown_mut(&mut self) -> Option<&mut Teardown> {
        match &mut self.kind {
            Kind::Teardown(teardown) => Some(teardown),
            _ => None,
        }
    }
}

fn teardown_mut(state: &mut State, id: OpId) -> Option<&mut Teardown> {
    state.ops.get_mut(&id)?.teardown_mut()
}

fn get(state: &State, id: OpId) -> Option<&Teardown> {
    state.ops.get(&id)?.teardown()
}

pub fn advance(state: &mut State, id: OpId, fx: &mut Fx) {
    let Some(teardown) = get(state, id) else { return };
    match teardown.phase {
        TearPhase::Queued => leave_queue(state, id, fx),
        TearPhase::Journaling => {
            if durable(id, &state.ops[&id]) {
                accepted(state, id, fx);
            }
        }
        TearPhase::RollingBack => {}
        TearPhase::Retiring => {
            let op = &state.ops[&id];
            let retired = op.sent.iter().all(|sent| !matches!(sent.cmd, Cmd::Retire { .. }) || sent.outcome.is_some());
            if retired || teardown.waited.retire {
                begin_stopping(state, id);
            }
        }
        TearPhase::Stopping => {
            if stopped(state, id) {
                after_stop(state, id);
            }
        }
        TearPhase::Reading => {
            if teardown.reading.is_empty() && durable(id, &state.ops[&id]) {
                plan_steps(state, id);
            }
        }
        TearPhase::Cleaning => clean(state, id, fx),
        TearPhase::Abandoned => {
            let op = &state.ops[&id];
            if op.book.as_ref().is_none_or(|book| book.flying.is_none()) {
                finish(state, id);
            }
        }
    }
}

fn leave_queue(state: &mut State, id: OpId, fx: &mut Fx) {
    let op = &state.ops[&id];
    let Kind::Teardown(teardown) = &op.kind else { return };
    let teams: BTreeSet<TeamId> = teardown.teams.iter().cloned().collect();
    let mut touched = teams.clone();
    if teardown.kind == model::Teardown::CloseAgent {
        if let Some(team) = teardown.panes.first().and_then(|pane| state.world.panes.get(pane)).and_then(|row| row.team.clone()) {
            touched.insert(team);
        }
    }
    if capture::additive_in_flight(state, id, &op.workspace, &touched, teardown.whole_workspace()) {
        return;
    }
    let world = state.world.clone();
    let workspace = op.workspace.clone();
    let Some(teardown) = teardown_mut(state, id) else { return };
    teardown.capture(&world, &workspace);
    if teardown.journals() {
        teardown.phase = TearPhase::Journaling;
    } else {
        answer_op(state.ops.get_mut(&id).expect("the op"), fx, Answer::Accepted { op: id, minted: Minted::default() });
        begin_retiring(state, id);
    }
}

/// The entry is on disk: the door hears «accepted», the targets are
/// forgotten, the launch state retires them.
fn accepted(state: &mut State, id: OpId, fx: &mut Fx) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    answer_op(op, fx, Answer::Accepted { op: id, minted: Minted::default() });
    let workspace = op.workspace.clone();
    let Some(teardown) = op.teardown() else { return };
    let (teams, panes, kind) = (teardown.teams.clone(), teardown.panes.clone(), teardown.kind);
    match kind {
        model::Teardown::CloseWorkspace => {
            state.forgotten.workspaces.insert(workspace);
            state.forgotten.teams.extend(teams);
            state.forgotten.panes.extend(panes);
        }
        model::Teardown::Disband => {
            state.forgotten.teams.extend(teams);
            state.forgotten.panes.extend(panes);
        }
        model::Teardown::CloseAgent => state.forgotten.panes.extend(panes),
        model::Teardown::Archive | model::Teardown::Restart | model::Teardown::Suspend => {}
    }
    begin_retiring(state, id);
}

fn begin_retiring(state: &mut State, id: OpId) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let workspace = op.workspace.clone();
    let Some(teardown) = op.teardown_mut() else { return };
    teardown.phase = TearPhase::Retiring;
    if teardown.restored {
        // A pane of a past launch has nothing launched in this one.
        teardown.waited.retire = true;
        return;
    }
    for pane in teardown.panes.clone() {
        op.send(Cmd::Retire { workspace: workspace.clone(), pane });
    }
}

/// The deck's rows go; unspent launch permits are revoked; admitted
/// launches are taken over for the start boundary.
fn begin_stopping(state: &mut State, id: OpId) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let workspace = op.workspace.clone();
    let Some(teardown) = op.teardown_mut() else { return };
    teardown.phase = TearPhase::Stopping;
    let rows = teardown.strategy().rows;
    let (teams, panes) = (teardown.teams.clone(), teardown.panes.clone());
    let deck: Vec<Cmd> = match rows {
        Rows::RemovePane => panes.iter().map(|&pane| Cmd::RemovePane { workspace: workspace.clone(), pane }).collect(),
        Rows::RemoveTeam => teams.iter().map(|team| Cmd::RemoveTeam { workspace: workspace.clone(), team: team.clone() }).collect(),
        Rows::RemoveWorkspace => vec![Cmd::RemoveWorkspace { workspace: workspace.clone() }],
        Rows::MarkArchived => vec![Cmd::MarkArchived { workspace: workspace.clone() }],
        Rows::MarkSuspended => panes.iter().map(|&pane| Cmd::MarkSuspended { workspace: workspace.clone(), pane }).collect(),
        Rows::Keep => Vec::new(),
    };
    for cmd in deck {
        if !op.sent.iter().any(|sent| sent.cmd == cmd) {
            op.send(cmd);
        }
    }
    let snapshot = state.ops[&id].clone();
    let Kind::Teardown(teardown) = &snapshot.kind else { return };
    let in_scope = |owner: &LaunchOwner, ws: &WorkspaceId, dir: Option<&Dir>| {
        owner.pane().is_some_and(|pane| teardown.panes.contains(&pane))
            || (teardown.whole_workspace() && ws == &snapshot.workspace)
            || dir.is_some_and(|dir| teardown.deleting().contains(dir))
    };
    state.permits.retain(|_, permit| match &permit.owner {
        Some(owner) => !in_scope(owner, &permit.workspace, permit.dir.as_ref()),
        None => true,
    });
    let mut taken = BTreeSet::new();
    for (&attempt, row) in state.attempts.iter_mut() {
        if row.by.is_none() && in_scope(&row.owner, &row.workspace, row.dir.as_ref()) {
            row.by = Some(id);
            taken.insert(attempt);
        }
    }
    if let Some(teardown) = teardown_mut(state, id) {
        teardown.taken = taken;
    }
}

/// Every session it covers is over, every launch it took over is settled at
/// the start boundary, the leases given before it are back — or their waits
/// ran out.
fn stopped(state: &State, id: OpId) -> bool {
    let op = &state.ops[&id];
    let Kind::Teardown(teardown) = &op.kind else { return false };
    let sessions = state.sessions_down || state.sessions.values().all(|session| session.ended || !teardown.covers(op, session));
    let boundary = teardown.taken.is_empty();
    let registered = teardown.waited.registration || teardown.started.iter().all(|attempt| !state.attempts.contains_key(attempt));
    let leases = teardown.waited.leases || !leases_out(state, op, teardown);
    let creations = !state.ops.iter().any(|(&other, op)| other != id && super::create::still_creating_for(op, &teardown.teams));
    let joined = teardown.joined.iter().all(|child| joined_done(state, *child));
    sessions && boundary && registered && leases && creations && joined
}

/// A joined operation is done enough once its sessions are stopped and its
/// rows gone; its debts are its own.
fn joined_done(state: &State, child: OpId) -> bool {
    match state.ops.get(&child).map(|op| &op.kind) {
        Some(Kind::Teardown(teardown)) => {
            matches!(teardown.phase, TearPhase::Reading | TearPhase::Cleaning) || state.ops[&child].owed
        }
        _ => true,
    }
}

fn leases_out(state: &State, op: &Op, teardown: &Teardown) -> bool {
    let folders = folders_of(state, op, teardown);
    state.permits.values().any(|permit| {
        permit.owner.is_none()
            && (permit.dir.as_ref().is_some_and(|dir| folders.contains(dir)) || (teardown.whole_workspace() && permit.workspace == op.workspace))
    })
}

/// The folders its teams and panes run in.
fn folders_of(state: &State, op: &Op, teardown: &Teardown) -> BTreeSet<Dir> {
    let mut folders: BTreeSet<Dir> = teardown.teams.iter().filter_map(|team| state.world.team_cwd(team)).collect();
    folders.extend(teardown.panes.iter().filter_map(|pane| state.world.pane_cwd(pane)));
    if teardown.whole_workspace() {
        if let Some(ws) = state.world.workspaces.get(&op.workspace) {
            folders.insert(ws.cwd.clone());
        }
    }
    folders.extend(teardown.deleting());
    folders
}

fn after_stop(state: &mut State, id: OpId) {
    let cleans = state.boot.cleans();
    let deletes = get(state, id).is_some_and(|teardown| teardown.strategy().delete_by_consent);
    let mut reading = BTreeSet::new();
    if deletes && cleans {
        let teardown = get(state, id).expect("a teardown");
        for folder in &teardown.consent.folders {
            if teardown.removals.iter().any(|removal| removal.path == folder.path) {
                continue;
            }
            if !folder_held(state, &folder.path, Some(id)) {
                reading.insert(folder.path.clone());
            }
        }
    }
    let Some(teardown) = teardown_mut(state, id) else { return };
    teardown.reading = reading;
    teardown.phase = TearPhase::Reading;
}

pub fn branches_read(state: &mut State, id: OpId, path: Dir, result: Result<Vec<String>, String>, fx: &mut Fx) {
    let Some(teardown) = teardown_mut(state, id) else { return };
    if teardown.phase != TearPhase::Reading || !teardown.reading.remove(&path) {
        return;
    }
    let Some(folder) = teardown.consent.folders.iter().find(|folder| folder.path == path).cloned() else { return };
    let mut branches = result.unwrap_or_else(|error| {
        fx.warn(format!("{id}: the branches of {} could not be read ({error})", path.as_str()));
        Vec::new()
    });
    if let Some(branch) = folder.branch {
        if !branches.contains(&branch) {
            branches.push(branch);
        }
    }
    teardown.removals.push(Removal { repo: folder.repo, path, branches });
}

/// The steps of the cleanup, in their order: plantings out, checkouts, then
/// branches; the workspace's stores; the owners' forgetting.
fn plan_steps(state: &mut State, id: OpId) {
    let op = state.ops[&id].clone();
    let Kind::Teardown(teardown) = &op.kind else { return };
    let strategy = teardown.strategy();
    let mut plan = Vec::new();
    if strategy.take_plantings && state.boot.cleans() {
        for dir in folders_of(state, &op, teardown) {
            if !folder_held(state, &dir, Some(id)) || state.world.workspaces.get(&op.workspace).is_some_and(|ws| ws.cwd == dir) {
                plan.push(Step::Disarm { dir });
            }
        }
    }
    for removal in &teardown.removals {
        plan.push(Step::Checkout { path: removal.path.clone() });
        for name in &removal.branches {
            plan.push(Step::Branch { repo: removal.repo.clone(), name: name.clone() });
        }
    }
    if strategy.forget == Forget::Workspace && state.boot.cleans() {
        plan.push(Step::Stores);
    }
    let workspace = op.workspace.clone();
    let mut forget = Vec::new();
    match strategy.forget {
        Forget::Nothing => {}
        Forget::PaneMail => {
            forget.extend(teardown.panes.iter().map(|&pane| Cmd::ForgetPaneMail { workspace: workspace.clone(), pane }));
        }
        Forget::Team => {
            forget.extend(teardown.teams.iter().map(|team| Cmd::DeleteTeamTasks { workspace: workspace.clone(), team: team.clone() }));
            forget.extend(teardown.panes.iter().map(|&pane| Cmd::ForgetPaneMail { workspace: workspace.clone(), pane }));
        }
        Forget::Workspace => {
            forget.push(Cmd::ForgetBoards { workspace: workspace.clone() });
            forget.push(Cmd::ForgetWorkspaceMail { workspace: workspace.clone() });
        }
    }
    let Some(op) = state.ops.get_mut(&id) else { return };
    for cmd in forget {
        if !op.sent.iter().any(|sent| sent.cmd == cmd) {
            op.send(cmd);
        }
    }
    let Some(teardown) = op.teardown_mut() else { return };
    teardown.plan = plan;
    teardown.phase = TearPhase::Cleaning;
}

/// The next steps of the plan that may run now: a checkout's branches only
/// once the checkout is gone, checkouts only once the plantings are out.
fn runnable(teardown: &Teardown) -> Vec<Step> {
    let settled = |step: &Step| teardown.done.contains(step) || teardown.failed.contains(step);
    let pending: Vec<&Step> = teardown.plan.iter().filter(|step| !settled(step)).collect();
    let disarming = pending.iter().any(|step| matches!(step, Step::Disarm { .. }));
    pending
        .into_iter()
        .filter(|step| match step {
            Step::Disarm { .. } | Step::Stores | Step::Discard | Step::Tag { .. } => true,
            Step::Checkout { .. } => !disarming,
            Step::Branch { repo, .. } => {
                let removal = teardown.removals.iter().find(|removal| &removal.repo == repo);
                !disarming
                    && removal.is_none_or(|removal| {
                        let checkout = Step::Checkout { path: removal.path.clone() };
                        teardown.done.contains(&checkout)
                    })
            }
        })
        .cloned()
        .collect()
}

fn clean(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let op = &state.ops[&id];
    let rows_settled = op.sent.iter().filter(|sent| sent.cmd.owner() == crate::command::Owner::Deck).all(|sent| sent.settled(saved));
    if rows_settled {
        apply_world(state, id);
    }
    let op = &state.ops[&id];
    let Some(teardown) = op.teardown() else { return };
    // A step still to run — not one that waits on a failed one before it.
    if !runnable(teardown).is_empty() || !op.all_settled(saved) {
        return;
    }
    if !teardown.failed.is_empty() {
        let failed = teardown.failed.len();
        state.ops.get_mut(&id).expect("the op").owed = true;
        fx.warn(format!("{id}: {failed} cleanup step(s) failed; the next launch retries them"));
        return;
    }
    finish(state, id);
}

/// Once its deck commands are on disk, the machine's world follows.
fn apply_world(state: &mut State, id: OpId) {
    let Some(op) = state.ops.get(&id) else { return };
    let Kind::Teardown(teardown) = &op.kind else { return };
    let workspace = op.workspace.clone();
    match teardown.strategy().rows {
        Rows::RemovePane => {
            for pane in &teardown.panes {
                state.world.panes.remove(pane);
            }
        }
        Rows::RemoveTeam => {
            for team in &teardown.teams {
                state.world.teams.remove(team);
            }
            for pane in &teardown.panes {
                state.world.panes.remove(pane);
            }
        }
        Rows::RemoveWorkspace => {
            state.world.workspaces.remove(&workspace);
            state.world.teams.retain(|_, team| team.workspace != workspace);
            state.world.panes.retain(|_, pane| pane.workspace != workspace);
        }
        Rows::MarkArchived => {
            if let Some(ws) = state.world.workspaces.get_mut(&workspace) {
                ws.archived = true;
            }
        }
        Rows::MarkSuspended => {
            for pane in teardown.panes.clone() {
                if let Some(row) = state.world.panes.get_mut(&pane) {
                    row.suspended = true;
                }
            }
        }
        Rows::Keep => {}
    }
}

pub fn step_done(state: &mut State, id: OpId, step: Step, result: StepResult, fx: &mut Fx) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let workspace = op.workspace.clone();
    match &mut op.kind {
        Kind::Teardown(teardown) => {
            if !teardown.plan.contains(&step) || teardown.done.contains(&step) || teardown.failed.contains(&step) {
                return;
            }
            match result {
                Ok(()) => teardown.done.push(step),
                Err(reason) => {
                    fx.warn(format!("{id}: {step:?} failed: {reason}"));
                    if let Step::Checkout { path } = &step {
                        op.sent.push(super::Sent::new(Cmd::WorktreeNotDeleted { workspace, path: path.clone(), reason }));
                    }
                    let Kind::Teardown(teardown) = &mut op.kind else { return };
                    teardown.failed.push(step);
                }
            }
        }
        Kind::RemoveUnheld(unheld) => {
            if unheld.done.contains(&step) {
                return;
            }
            match result {
                Ok(()) => unheld.done.push(step),
                Err(reason) => {
                    fx.warn(format!("{id}: {step:?} failed: {reason}"));
                    unheld.failed = true;
                }
            }
        }
        Kind::Fork(fork) => super::create::fork_step_done(fork, step, result, fx, id),
        Kind::Create(create) => super::create::undo_step_done(create, step, result, fx, id),
        Kind::Reconcile(reconcile) => {
            if let Err(reason) = result {
                fx.warn(format!("{id}: the stores kept data of gone workspaces: {reason}; the next launch tries again"));
            }
            super::boot::reconcile_done(reconcile);
        }
        _ => {}
    }
}

pub fn cancelled(state: &mut State, id: OpId, started: Vec<AttemptId>) {
    let Some(teardown) = teardown_mut(state, id) else { return };
    let taken = std::mem::take(&mut teardown.taken);
    for attempt in taken {
        if started.contains(&attempt) {
            teardown.started.insert(attempt);
        }
    }
    // The cancelled ones never start: they are done at the boundary.
    let cancelled: Vec<AttemptId> = state.attempts.iter().filter(|(a, row)| row.by == Some(id) && !started.contains(a)).map(|(&a, _)| a).collect();
    for attempt in cancelled {
        state.attempts.remove(&attempt);
    }
}

pub fn waited(state: &mut State, id: OpId, timer: &Timer) {
    let Some(teardown) = teardown_mut(state, id) else { return };
    match timer {
        Timer::Retire { .. } if teardown.phase == TearPhase::Retiring => teardown.waited.retire = true,
        Timer::Leases { .. } if teardown.phase == TearPhase::Stopping => teardown.waited.leases = true,
        Timer::Registration { .. } if teardown.phase == TearPhase::Stopping => teardown.waited.registration = true,
        _ => {}
    }
}

pub fn work(state: &State, id: OpId, op: &Op, teardown: &Teardown, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    match teardown.phase {
        TearPhase::Retiring if !teardown.waited.retire => {
            owed = owed.after(RETIRE_WAIT, Event::Timer(Timer::Retire { op: id }));
        }
        TearPhase::Stopping => {
            for (&session, row) in &state.sessions {
                if !row.ended && teardown.covers(op, row) {
                    owed = owed.run(Effect::Stop { session });
                }
            }
            if !teardown.taken.is_empty() {
                owed = owed.run(Effect::Cancel { op: id, attempts: teardown.taken.iter().copied().collect() });
            }
            if !teardown.started.is_empty() && !teardown.waited.registration {
                owed = owed.after(REGISTRATION_WAIT, Event::Timer(Timer::Registration { op: id }));
            }
            if !teardown.waited.leases && leases_out(state, op, teardown) {
                owed = owed.after(LEASE_WAIT, Event::Timer(Timer::Leases { op: id }));
            }
        }
        TearPhase::Reading => {
            for path in &teardown.reading {
                if let Some(folder) = teardown.consent.folders.iter().find(|folder| &folder.path == path) {
                    owed = owed.run(Effect::ReadBranches { op: id, repo: folder.repo.clone(), path: path.clone() });
                }
            }
        }
        TearPhase::Cleaning => {
            for step in runnable(teardown) {
                let how = match &step {
                    Step::Checkout { path } => {
                        let Some(removal) = teardown.removals.iter().find(|removal| &removal.path == path) else { continue };
                        Clean::Checkout { repo: removal.repo.clone(), path: path.clone() }
                    }
                    Step::Branch { repo, name } => Clean::Branch { repo: repo.clone(), name: name.clone() },
                    Step::Disarm { dir } => Clean::Disarm { dir: dir.clone() },
                    Step::Stores => Clean::Stores,
                    Step::Discard | Step::Tag { .. } => continue,
                };
                owed = owed.run(Effect::Clean { op: id, workspace: op.workspace.clone(), step, how });
            }
        }
        _ => {}
    }
    owed
}

/// «Remove unheld»: one guarded operation — the folder captured, its HEAD
/// tagged if asked, the checkout removed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Unheld {
    pub path: Dir,
    pub tag: Option<String>,
    pub done: Vec<Step>,
    pub failed: bool,
    pub rolling_back: bool,
    pub answered: bool,
}

impl Unheld {
    pub fn new(path: Dir, tag: Option<String>) -> Unheld {
        Unheld { path, tag, done: Vec::new(), failed: false, rolling_back: false, answered: false }
    }

    pub fn journaled(&self) -> Work {
        Work::RemoveUnheld { path: self.path.clone(), tag: self.tag.clone(), removal: None }
    }

    fn steps(&self) -> Vec<Step> {
        let mut steps = Vec::new();
        if let Some(name) = &self.tag {
            steps.push(Step::Tag { path: self.path.clone(), name: name.clone() });
        }
        steps.push(Step::Checkout { path: self.path.clone() });
        steps
    }
}

pub fn advance_unheld(state: &mut State, id: OpId, fx: &mut Fx) {
    let ready = durable(id, &state.ops[&id]);
    let Some(op) = state.ops.get_mut(&id) else { return };
    let Kind::RemoveUnheld(unheld) = &mut op.kind else { return };
    if !ready {
        return;
    }
    if !unheld.answered {
        unheld.answered = true;
        answer_op(op, fx, Answer::Accepted { op: id, minted: Minted::default() });
        return;
    }
    let Kind::RemoveUnheld(unheld) = &op.kind else { return };
    if unheld.failed {
        op.owed = true;
        return;
    }
    if unheld.steps().iter().all(|step| unheld.done.contains(step)) {
        finish(state, id);
    }
}

pub fn work_unheld(state: &State, id: OpId, op: &Op, unheld: &Unheld, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    if !unheld.answered || unheld.failed || !state.boot.open() {
        return owed;
    }
    let repo = state.world.workspaces.get(&op.workspace).map(|ws| ws.cwd.clone());
    let Some(repo) = repo else { return owed };
    for step in unheld.steps() {
        if unheld.done.contains(&step) {
            continue;
        }
        let how = match &step {
            Step::Tag { path, name } => Clean::TagHead { repo: repo.clone(), path: path.clone(), tag: name.clone() },
            Step::Checkout { path } => Clean::Checkout { repo: repo.clone(), path: path.clone() },
            _ => continue,
        };
        owed = owed.run(Effect::Clean { op: id, workspace: op.workspace.clone(), step, how });
        break;
    }
    owed
}
