//! Making things: workspaces, teams with their places, seats, resumed and
//! forked conversations, relocations.
//!
//! A team in a new worktree gets its place from the machine — the first
//! number nobody holds, then the disk's word on it — and a ticket written to
//! the journal before `git worktree add`. A fork is finished only when its
//! pane's launch is bound to the fork's conversation; any other end takes
//! back everything the fork made.

use super::{answer_op, durable, finish, Clean, Effect, Event, Fx, Kind, Op, State, StepResult, Timer, FORK_DEADLINE};
use crate::command::{Cmd, Member, Outcome, Revision, TeamPlace};
use crate::dir::Dir;
use crate::ids::{OpId, PaneId, TeamId};
use crate::journal::{Discard, Step, Ticket, Work};
use crate::model::{Answer, Draft, Minted, Refusal, SessionKey, Site};
use crate::places::{self, Held};
use crate::world::{Pane, Team, TeamAt};
use keepdeck_fsm::Owed;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CreateStage {
    /// Its place is being chosen and asked of the disk.
    Placing,
    Journaling,
    RollingBack,
    /// The deck is adding the team (or showing a Retry as creating).
    Adding,
    /// `git worktree add` by the ticket.
    Creating,
    /// Its last deck commands are settling.
    Settling,
    /// Boot found its entry but no team on the deck: what its ticket may have
    /// made is taken back.
    Undoing,
}

/// A team being made.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Create {
    pub team: TeamId,
    pub draft: Draft,
    pub site: Site,
    pub members: Vec<Member>,
    /// The first member resumes this conversation.
    pub resume: Option<SessionKey>,
    pub retry: bool,
    /// Part of a fork: the fork carries its conversation in once it exists.
    pub for_fork: bool,
    pub ticket: Option<Ticket>,
    /// The next automatic place to ask about.
    pub from: u32,
    /// The place asked of the disk now.
    pub probing: Option<(Dir, String)>,
    pub stage: CreateStage,
    /// A Close took it over: it ends once its git step is back.
    pub abandoned: bool,
    /// `git worktree add` has answered.
    pub created: bool,
    /// The steps of an undo that are done.
    pub undone: Vec<Step>,
    pub undo_failed: bool,
}

impl Create {
    pub fn new(team: TeamId, draft: Draft, site: Site, members: Vec<Member>, resume: Option<SessionKey>, for_fork: bool) -> Create {
        Create {
            team,
            draft,
            site,
            members,
            resume,
            retry: false,
            for_fork,
            ticket: None,
            from: 1,
            probing: None,
            stage: CreateStage::Placing,
            abandoned: false,
            created: false,
            undone: Vec::new(),
            undo_failed: false,
        }
    }

    /// The steps that take back what its ticket made: the checkout, then
    /// the branch it was created on.
    fn undo_steps(&self) -> Vec<Step> {
        let Some(ticket) = &self.ticket else { return Vec::new() };
        vec![Step::Checkout { path: ticket.path.clone() }, Step::Branch { repo: ticket.repo.clone(), name: ticket.branch.clone() }]
    }

    pub fn retry(team: TeamId, ticket: Ticket) -> Create {
        let mut create = Create::new(team, Draft(serde_json::Value::Null), Site::Root, Vec::new(), None, false);
        create.retry = true;
        create.ticket = Some(ticket);
        create.stage = CreateStage::Journaling;
        create
    }

    fn worktree(&self) -> bool {
        self.retry || matches!(self.site, Site::New { .. })
    }

    pub fn journaled(&self) -> Option<Work> {
        let ticket = self.ticket.clone()?;
        (self.worktree() && self.stage != CreateStage::Placing).then(|| Work::Create { team: self.team.clone(), ticket })
    }

    pub fn abandon(&mut self) {
        self.abandoned = true;
    }
}

/// A pane added to a team — a seat, or a resume of a recorded conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Seat {
    pub team: TeamId,
    pub pane: PaneId,
    pub draft: Draft,
    pub resume: Option<SessionKey>,
}

impl Seat {
    pub fn new(team: TeamId, pane: PaneId, draft: Draft, resume: Option<SessionKey>) -> Seat {
        Seat { team, pane, draft, resume }
    }
}

/// A member moved to the workspace's root team.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relocate {
    pub pane: PaneId,
    pub from: Option<TeamId>,
    pub to: TeamId,
    pub new_root: bool,
}

impl Relocate {
    pub fn new(pane: PaneId, from: Option<TeamId>, to: TeamId, new_root: bool) -> Relocate {
        Relocate { pane, from, to, new_root }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForkStage {
    /// The team made for it is being placed.
    Placing,
    Journaling,
    RollingBack,
    /// The team made for it is being added and created.
    Making,
    /// The plugin's hook is carrying the conversation.
    Forking,
    /// The pane is being added — or the team made for it settled.
    Adding,
    /// Waiting for the pane's launch to be bound to the fork's conversation.
    Binding,
    /// Bound: the scaffolding is removed.
    Finishing,
    /// It did not finish: everything it made is taken back.
    Undoing,
}

/// A conversation carried into a new pane.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fork {
    pub team: TeamId,
    pub pane: PaneId,
    pub draft: Draft,
    pub source: SessionKey,
    /// The team made for it, if it makes one.
    pub create: Option<Create>,
    pub stage: ForkStage,
    pub discard: Option<Discard>,
    pub hook_sent: bool,
    pub hook_ended: bool,
    pub expired: bool,
    pub done: Vec<Step>,
    pub failed: bool,
    /// The deck holds its pane — and its team, if it made one.
    pub added: bool,
}

impl Fork {
    pub fn new(team: TeamId, pane: PaneId, draft: Draft, source: SessionKey, create: Option<Create>) -> Fork {
        let stage = if create.is_some() { ForkStage::Placing } else { ForkStage::Journaling };
        Fork {
            team,
            pane,
            draft,
            source,
            create,
            stage,
            discard: None,
            hook_sent: false,
            hook_ended: false,
            expired: false,
            done: Vec::new(),
            failed: false,
            added: false,
        }
    }

    pub fn journaled(&self) -> Work {
        Work::Fork {
            pane: self.pane,
            source: self.source.clone(),
            team: self.create.as_ref().map(|create| create.team.clone()),
            ticket: self.create.as_ref().and_then(|create| create.ticket.clone()),
            discard: self.discard.clone(),
        }
    }
}

/// The ops that change a team's membership and have not settled it yet.
pub fn membership_pending(op: &Op, saved: Option<Revision>) -> bool {
    let unsettled = |pred: fn(&Cmd) -> bool| op.sent.iter().any(|sent| pred(&sent.cmd) && !sent.settled(saved));
    match &op.kind {
        Kind::Seat(_) => op.ask.is_some() || unsettled(|cmd| matches!(cmd, Cmd::AddPane { .. })),
        Kind::Relocate(_) => op.ask.is_some() || unsettled(|cmd| matches!(cmd, Cmd::MovePane { .. })),
        Kind::Fork(fork) => match fork.stage {
            ForkStage::Journaling | ForkStage::Forking => !fork.expired,
            ForkStage::Adding => true,
            ForkStage::Placing | ForkStage::Making | ForkStage::RollingBack => false,
            ForkStage::Binding | ForkStage::Finishing | ForkStage::Undoing => unsettled(|cmd| matches!(cmd, Cmd::AddPane { .. })),
        },
        _ => false,
    }
}

pub fn touched_teams(op: &Op) -> Vec<TeamId> {
    match &op.kind {
        Kind::Seat(seat) => vec![seat.team.clone()],
        Kind::Fork(fork) => vec![fork.team.clone()],
        Kind::Relocate(relocate) => relocate.from.iter().cloned().chain([relocate.to.clone()]).collect(),
        _ => Vec::new(),
    }
}

/// The conversation an operation holds for a resume, while it goes.
pub fn reserves(op: &Op) -> Option<&SessionKey> {
    match &op.kind {
        Kind::Seat(seat) => seat.resume.as_ref(),
        Kind::Create(create) => create.resume.as_ref(),
        _ => None,
    }
}

fn create_of(op: &Op) -> Option<&Create> {
    match &op.kind {
        Kind::Create(create) => Some(&**create),
        Kind::Fork(fork) => fork.create.as_ref(),
        _ => None,
    }
}

/// An operation's ticket or the place it is asking about is this folder.
pub fn holds_folder(op: &Op, dir: &Dir) -> bool {
    create_of(op).is_some_and(|create| {
        create.ticket.as_ref().is_some_and(|ticket| &ticket.path == dir) || create.probing.as_ref().is_some_and(|(path, _)| path == dir)
    })
}

/// A creation of one of these teams is still in `git worktree add`.
pub fn still_creating_for(op: &Op, teams: &[TeamId]) -> bool {
    create_of(op).is_some_and(|create| teams.contains(&create.team) && create.stage == CreateStage::Creating && !create.created)
}

/// Every folder and branch held for a place in this workspace.
pub(super) fn held(state: &State, workspace: &crate::ids::WorkspaceId) -> Held {
    let mut held = Held::default();
    for team in state.world.teams.values().filter(|team| &team.workspace == workspace) {
        match &team.at {
            TeamAt::Attached { cwd, branch } => {
                held.paths.insert(cwd.clone());
                held.branches.extend(branch.clone());
            }
            TeamAt::Creating { ticket, .. } | TeamAt::Failed { ticket } => {
                held.paths.insert(ticket.path.clone());
                held.branches.insert(ticket.branch.clone());
            }
            TeamAt::Unplaced => {}
        }
    }
    for op in state.ops.values().filter(|op| &op.workspace == workspace) {
        if let Some(create) = create_of(op) {
            if let Some(ticket) = &create.ticket {
                held.paths.insert(ticket.path.clone());
                held.branches.insert(ticket.branch.clone());
            }
            if let Some((path, branch)) = &create.probing {
                held.paths.insert(path.clone());
                held.branches.insert(branch.clone());
            }
        }
        if let Some(teardown) = op.teardown() {
            for removal in &teardown.removals {
                held.paths.insert(removal.path.clone());
                held.branches.extend(removal.branches.iter().cloned());
            }
            for folder in &teardown.consent.folders {
                held.paths.insert(folder.path.clone());
                held.branches.extend(folder.branch.clone());
            }
        }
    }
    held
}

fn create_mut(op: &mut Op) -> Option<&mut Create> {
    match &mut op.kind {
        Kind::Create(create) => Some(&mut **create),
        Kind::Fork(fork) => fork.create.as_mut(),
        _ => None,
    }
}

/// Choose the place to ask the disk about, or refuse when there is none.
/// Returns the refusal that ends the operation, if one does.
fn place(state: &mut State, id: OpId) -> Option<Refusal> {
    let op = &state.ops[&id];
    let workspace = op.workspace.clone();
    let create = create_of(op).expect("a creation");
    if create.probing.is_some() || create.ticket.is_some() {
        return None;
    }
    let ws = state.world.workspaces.get(&workspace)?.clone();
    let mut held = held(state, &workspace);
    let candidate = match &create.site {
        Site::New { place: Some(manual), .. } => {
            // A place typed by hand meets the same rule — held by anyone,
            // and it is refused, never moved aside.
            let own = create.probing.as_ref().map(|(path, _)| path.clone());
            held.paths.retain(|path| Some(path) != own.as_ref());
            if held.holds(&manual.path, &manual.branch) {
                return Some(Refusal::LocationHeld);
            }
            (manual.path.clone(), manual.branch.clone())
        }
        Site::New { place: None, .. } => {
            let Some(base) = &ws.base else { return Some(Refusal::LocationHeld) };
            let n = places::first_free(&held, base, &ws.name, create.from);
            (places::path(base, &ws.name, n), places::branch(&ws.name, n))
        }
        Site::Root | Site::Existing { .. } => return None,
    };
    let op = state.ops.get_mut(&id).expect("the op");
    create_mut(op).expect("a creation").probing = Some(candidate);
    None
}

pub fn probed(state: &mut State, id: OpId, path: Dir, taken: bool, fx: &mut Fx) {
    let Some(workspace) = state.ops.get(&id).map(|op| op.workspace.clone()) else { return };
    let ws = state.world.workspaces.get(&workspace).cloned();
    let Some(op) = state.ops.get_mut(&id) else { return };
    let Some(create) = create_mut(op) else { return };
    if create.probing.as_ref().map(|(probed, _)| probed) != Some(&path) {
        return;
    }
    let (path, branch) = create.probing.take().expect("probing");
    let manual = matches!(create.site, Site::New { place: Some(_), .. });
    if taken {
        if manual {
            answer_op(op, fx, Answer::refused(Refusal::LocationHeld));
            state.ops.remove(&id);
        } else {
            let number = path.as_str().rsplit('-').next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(create.from);
            create.from = number + 1;
        }
        return;
    }
    let base = match &create.site {
        Site::New { base, .. } => base.clone(),
        _ => None,
    };
    let Some(ws) = ws else { return };
    create.ticket = Some(Ticket { repo: ws.cwd, path, branch, base });
    create.stage = CreateStage::Journaling;
    if let Kind::Fork(fork) = &mut op.kind {
        fork.stage = ForkStage::Journaling;
    }
}

pub fn created(state: &mut State, id: OpId, result: StepResult, fx: &mut Fx) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let workspace = op.workspace.clone();
    let Some(create) = create_mut(op) else { return };
    if create.stage != CreateStage::Creating || create.created {
        return;
    }
    create.created = true;
    let ticket = create.ticket.clone().expect("a ticket");
    let team = create.team.clone();
    if create.abandoned {
        return;
    }
    let for_fork = create.for_fork;
    match result {
        Ok(()) => {
            if let Some(row) = state.world.teams.get_mut(&team) {
                row.at = TeamAt::Attached { cwd: ticket.path.clone(), branch: Some(ticket.branch.clone()) };
            }
            if !for_fork {
                op.send(Cmd::SettleTeam { workspace, team, cwd: ticket.path, branch: Some(ticket.branch) });
                if let Some(create) = create_mut(op) {
                    create.stage = CreateStage::Settling;
                }
            }
        }
        Err(reason) => {
            fx.warn(format!("{id}: the worktree of {} was not created: {reason}", ticket.path.as_str()));
            if let Some(row) = state.world.teams.get_mut(&team) {
                row.at = TeamAt::Failed { ticket };
            }
            op.send(Cmd::FailTeam { workspace, team, reason });
            if let Some(create) = create_mut(op) {
                create.stage = CreateStage::Settling;
            }
            if let Kind::Fork(fork) = &mut op.kind {
                fork.stage = ForkStage::Undoing;
            }
        }
    }
}

/// The outcome of the first command of this kind, if it came.
fn outcome_of(op: &Op, pred: impl Fn(&Cmd) -> bool) -> Option<Option<&Outcome>> {
    op.sent.iter().find(|sent| pred(&sent.cmd)).map(|sent| sent.outcome.as_ref())
}

fn reason(outcome: &Outcome) -> Option<String> {
    match outcome {
        Outcome::Rejected { reason } => Some(reason.clone()),
        _ => None,
    }
}

pub fn advance_workspace(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    if let Some(Some(outcome)) = outcome_of(op, |cmd| matches!(cmd, Cmd::AddWorkspace { .. })) {
        if let Some(reason) = reason(outcome) {
            answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
            state.world.workspaces.remove(&workspace);
            state.ops.remove(&id);
            return;
        }
        answer_op(op, fx, Answer::Accepted { op: id, minted: Minted { workspace: Some(workspace), ..Minted::default() } });
        if op.all_settled(saved) {
            finish(state, id);
        }
    }
}

pub fn advance_create(state: &mut State, id: OpId, fx: &mut Fx) {
    let stage = match &state.ops[&id].kind {
        Kind::Create(create) => create.stage,
        _ => return,
    };
    let saved = state.saved;
    match stage {
        CreateStage::Placing => {
            if let Some(refusal) = place(state, id) {
                let op = state.ops.get_mut(&id).expect("the op");
                answer_op(op, fx, Answer::refused(refusal));
                state.ops.remove(&id);
                return;
            }
            let op = state.ops.get_mut(&id).expect("the op");
            let Kind::Create(create) = &mut op.kind else { return };
            if !create.worktree() {
                create.stage = CreateStage::Adding;
            }
        }
        CreateStage::Journaling => {
            if durable(id, &state.ops[&id]) {
                let op = state.ops.get_mut(&id).expect("the op");
                let Kind::Create(create) = &mut op.kind else { return };
                create.stage = CreateStage::Adding;
            }
        }
        CreateStage::RollingBack => {}
        CreateStage::Adding => add_team(state, id, fx),
        CreateStage::Creating => {
            let op = &state.ops[&id];
            if let Kind::Create(create) = &op.kind {
                if create.abandoned && create.created {
                    finish(state, id);
                }
            }
        }
        CreateStage::Settling => {
            if state.ops[&id].all_settled(saved) {
                finish(state, id);
            }
        }
        CreateStage::Undoing => {
            let op = state.ops.get_mut(&id).expect("the op");
            let Kind::Create(create) = &op.kind else { return };
            if create.undo_failed {
                op.owed = true;
            } else if create.undo_steps().iter().all(|step| create.undone.contains(step)) {
                finish(state, id);
            }
        }
    }
}

pub fn undo_step_done(create: &mut Create, step: Step, result: StepResult, fx: &mut Fx, id: OpId) {
    if create.stage != CreateStage::Undoing || create.undone.contains(&step) {
        return;
    }
    match result {
        Ok(()) => create.undone.push(step),
        Err(reason) => {
            fx.warn(format!("{id}: {step:?} failed: {reason}"));
            create.undo_failed = true;
        }
    }
}

/// The deck adds the team with its members — or shows a Retry as creating —
/// after the resume plan, if the first member resumes.
fn add_team(state: &mut State, id: OpId, fx: &mut Fx) {
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    let Kind::Create(create) = &op.kind else { return };
    let create = create.clone();
    if create.abandoned {
        answer_op(op, fx, Answer::refused(Refusal::TargetLeaving));
        finish(state, id);
        return;
    }
    if let (Some(source), Some(first)) = (&create.resume, create.members.first()) {
        match outcome_of(op, |cmd| matches!(cmd, Cmd::PrepareResume { .. })) {
            None => {
                op.send(Cmd::PrepareResume { workspace, pane: first.pane, source: source.clone() });
                return;
            }
            Some(None) => return,
            Some(Some(outcome)) => {
                if let Some(reason) = reason(outcome) {
                    answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
                    finish(state, id);
                    return;
                }
            }
        }
    }
    let is_add = |cmd: &Cmd| matches!(cmd, Cmd::AddTeam { .. } | Cmd::RetryTeam { .. });
    match outcome_of(op, is_add) {
        None => {
            let cmd = if create.retry {
                Cmd::RetryTeam { workspace, team: create.team.clone() }
            } else {
                Cmd::AddTeam {
                    workspace: workspace.clone(),
                    team: create.team.clone(),
                    draft: create.draft.clone(),
                    place: team_place(state, &workspace, &create, id),
                    members: create.members.clone(),
                }
            };
            let op = state.ops.get_mut(&id).expect("the op");
            op.send(cmd);
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(reason) = reason(outcome) {
                answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
                finish(state, id);
                return;
            }
            let minted = Minted {
                team: Some(create.team.clone()),
                panes: create.members.iter().map(|member| member.pane).collect(),
                ..Minted::default()
            };
            answer_op(op, fx, Answer::Accepted { op: id, minted });
            let at = match (&create.site, &create.ticket) {
                (_, Some(ticket)) => TeamAt::Creating { op: id, ticket: ticket.clone() },
                (Site::Existing { cwd }, None) => TeamAt::Attached { cwd: cwd.clone(), branch: None },
                (_, None) => {
                    let cwd = state.world.workspaces[&workspace].cwd.clone();
                    TeamAt::Attached { cwd, branch: None }
                }
            };
            state.world.teams.insert(create.team.clone(), Team { workspace: workspace.clone(), at });
            for member in &create.members {
                state.world.panes.insert(member.pane, Pane { workspace: workspace.clone(), team: Some(create.team.clone()), remote: false, suspended: false });
            }
            let op = state.ops.get_mut(&id).expect("the op");
            let Kind::Create(create) = &mut op.kind else { return };
            create.stage = if create.worktree() { CreateStage::Creating } else { CreateStage::Settling };
        }
    }
}

fn team_place(state: &State, workspace: &crate::ids::WorkspaceId, create: &Create, id: OpId) -> TeamPlace {
    match (&create.ticket, &create.site) {
        (Some(ticket), _) => TeamPlace::Provisioning { op: id, path: ticket.path.clone(), branch: ticket.branch.clone(), base: ticket.base.clone() },
        (None, Site::Existing { cwd }) => TeamPlace::Attached { cwd: cwd.clone(), branch: None },
        (None, _) => TeamPlace::Attached { cwd: state.world.workspaces[workspace].cwd.clone(), branch: None },
    }
}

pub fn work(state: &State, id: OpId, op: &Op, create: &Create, owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    work_create(state, id, op, create, owed)
}

fn work_create(state: &State, id: OpId, op: &Op, create: &Create, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    if let Some((path, branch)) = &create.probing {
        if let Some(ws) = state.world.workspaces.get(&op.workspace) {
            owed = owed.run(Effect::Probe { op: id, repo: ws.cwd.clone(), path: path.clone(), branch: branch.clone() });
        }
    }
    if create.stage == CreateStage::Creating && !create.created {
        if let Some(ticket) = &create.ticket {
            owed = owed.run(Effect::CreateWorktree { op: id, ticket: ticket.clone() });
        }
    }
    if create.stage == CreateStage::Undoing && !create.undo_failed && state.boot.cleans() {
        if let Some(ticket) = &create.ticket {
            // The branch goes only once the checkout is gone.
            let checkout = Step::Checkout { path: ticket.path.clone() };
            let step = if create.undone.contains(&checkout) {
                Step::Branch { repo: ticket.repo.clone(), name: ticket.branch.clone() }
            } else {
                checkout
            };
            let how = match &step {
                Step::Checkout { path } => Clean::Checkout { repo: ticket.repo.clone(), path: path.clone() },
                _ => Clean::Branch { repo: ticket.repo.clone(), name: ticket.branch.clone(), confirmed_absent: false },
            };
            if !create.undone.contains(&step) {
                owed = owed.run(Effect::Clean { op: id, workspace: op.workspace.clone(), step, how });
            }
        }
    }
    owed
}

pub fn advance_seat(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    let Kind::Seat(seat) = &op.kind else { return };
    let seat = seat.clone();
    if let Some(source) = &seat.resume {
        match outcome_of(op, |cmd| matches!(cmd, Cmd::PrepareResume { .. })) {
            None => {
                op.send(Cmd::PrepareResume { workspace, pane: seat.pane, source: source.clone() });
                return;
            }
            Some(None) => return,
            Some(Some(outcome)) => {
                if let Some(reason) = reason(outcome) {
                    answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
                    finish(state, id);
                    return;
                }
            }
        }
    }
    match outcome_of(op, |cmd| matches!(cmd, Cmd::AddPane { .. })) {
        None => {
            op.send(Cmd::AddPane { workspace, team: seat.team.clone(), pane: seat.pane, draft: seat.draft.clone() });
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(reason) = reason(outcome) {
                if op.ask.is_some() && seat.resume.is_some() {
                    // The plan built for it has nowhere to run.
                    op.send(Cmd::Retire { workspace, pane: seat.pane });
                }
                answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
            } else if op.ask.is_some() {
                answer_op(op, fx, Answer::Accepted { op: id, minted: Minted { panes: vec![seat.pane], ..Minted::default() } });
                state.world.panes.insert(seat.pane, Pane { workspace, team: Some(seat.team.clone()), remote: false, suspended: false });
            }
            if state.ops[&id].all_settled(saved) {
                finish(state, id);
            }
        }
    }
}

pub fn advance_relocate(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    let Kind::Relocate(relocate) = &op.kind else { return };
    let relocate = relocate.clone();
    match outcome_of(op, |cmd| matches!(cmd, Cmd::MovePane { .. })) {
        None => {
            op.send(Cmd::MovePane { workspace, pane: relocate.pane, to: relocate.to.clone(), new_root: relocate.new_root });
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(reason) = reason(outcome) {
                answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
            } else if op.ask.is_some() {
                answer_op(op, fx, Answer::Accepted { op: id, minted: Minted::default() });
                if relocate.new_root {
                    let cwd = state.world.workspaces[&workspace].cwd.clone();
                    state.world.teams.insert(relocate.to.clone(), Team { workspace: workspace.clone(), at: TeamAt::Attached { cwd, branch: None } });
                }
                if let Some(row) = state.world.panes.get_mut(&relocate.pane) {
                    row.team = Some(relocate.to.clone());
                }
            }
            if state.ops[&id].all_settled(saved) {
                finish(state, id);
            }
        }
    }
}

/// Restore and resume: one deck command; the world follows once it is on disk.
pub fn advance_flag(state: &mut State, id: OpId, _fx: &mut Fx) {
    let op = &state.ops[&id];
    if !op.all_settled(state.saved) {
        return;
    }
    let rejected = op.sent.iter().any(|sent| sent.rejected().is_some());
    let workspace = op.workspace.clone();
    if !rejected {
        match &op.kind {
            Kind::Restore => {
                if let Some(ws) = state.world.workspaces.get_mut(&workspace) {
                    ws.archived = false;
                }
            }
            Kind::Resume { pane } => {
                if let Some(row) = state.world.panes.get_mut(pane) {
                    row.suspended = false;
                }
            }
            _ => {}
        }
    }
    finish(state, id);
}

// ---------------------------------------------------------------- the fork

fn fork_mut(op: &mut Op) -> Option<&mut Fork> {
    match &mut op.kind {
        Kind::Fork(fork) => Some(&mut **fork),
        _ => None,
    }
}

pub fn fork_deadline(state: &mut State, id: OpId) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let workspace = op.workspace.clone();
    let Some(fork) = fork_mut(op) else { return };
    if fork.stage != ForkStage::Forking || fork.expired {
        return;
    }
    fork.expired = true;
    fork.stage = ForkStage::Undoing;
    let _ = workspace;
    op.send(Cmd::DropBuild { op: id });
}

pub fn fork_step_done(fork: &mut Fork, step: Step, result: StepResult, fx: &mut Fx, id: OpId) {
    if fork.done.contains(&step) {
        return;
    }
    match result {
        Ok(()) => fork.done.push(step),
        Err(reason) => {
            fx.warn(format!("{id}: {step:?} failed: {reason}"));
            fork.failed = true;
        }
    }
}

/// The folder the fork carries the conversation into.
fn fork_cwd(state: &State, fork: &Fork) -> Option<Dir> {
    match &fork.create {
        Some(create) => create.ticket.as_ref().map(|ticket| ticket.path.clone()),
        None => state.world.team_cwd(&fork.team),
    }
}

/// The pane's launch is still alive, or about to be.
fn fork_pane_busy(state: &State, pane: PaneId) -> bool {
    state.sessions.values().any(|row| !row.ended && row.owner.pane() == Some(pane))
        || state.attempts.values().any(|attempt| attempt.owner.pane() == Some(pane))
}

pub fn advance_fork(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let stage = match &state.ops[&id].kind {
        Kind::Fork(fork) => fork.stage,
        _ => return,
    };
    match stage {
        ForkStage::Placing => {
            if let Some(refusal) = place(state, id) {
                let op = state.ops.get_mut(&id).expect("the op");
                answer_op(op, fx, Answer::refused(refusal));
                state.ops.remove(&id);
                return;
            }
            let op = state.ops.get_mut(&id).expect("the op");
            let Some(fork) = fork_mut(op) else { return };
            if fork.create.as_ref().is_some_and(|create| !create.worktree()) {
                fork.stage = ForkStage::Journaling;
            }
        }
        ForkStage::Journaling => {
            if durable(id, &state.ops[&id]) {
                let op = state.ops.get_mut(&id).expect("the op");
                let Some(fork) = fork_mut(op) else { return };
                fork.stage = if fork.create.is_some() { ForkStage::Making } else { ForkStage::Forking };
            }
        }
        ForkStage::RollingBack => {}
        ForkStage::Making => make_fork_team(state, id, fx),
        ForkStage::Forking => {
            let cwd = {
                let Kind::Fork(fork) = &state.ops[&id].kind else { return };
                fork_cwd(state, fork)
            };
            let op = state.ops.get_mut(&id).expect("the op");
            let workspace = op.workspace.clone();
            let outcome = outcome_of(op, |cmd| matches!(cmd, Cmd::Fork { .. })).map(|outcome| outcome.cloned());
            let Some(fork) = fork_mut(op) else { return };
            match outcome {
                None => {
                    let Some(cwd) = cwd else { return };
                    fork.hook_sent = true;
                    let (pane, source) = (fork.pane, fork.source.clone());
                    op.send(Cmd::Fork { workspace, pane, source, cwd });
                }
                Some(None) => {}
                Some(Some(Outcome::Forked { discard })) => {
                    fork.discard = Some(discard);
                    fork.stage = ForkStage::Adding;
                }
                Some(Some(outcome)) => {
                    let reason = reason(&outcome).unwrap_or_else(|| "the fork step gave no result".into());
                    fork.stage = ForkStage::Undoing;
                    answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
                }
            }
        }
        ForkStage::Adding => {
            // The hook's result — what to remove if the fork does not
            // finish — reaches the journal before the pane does.
            let written = state.ops[&id].book.as_ref().and_then(|book| book.written.as_ref());
            if !written.is_some_and(|entry| matches!(&entry.work, Work::Fork { discard: Some(_), .. })) {
                return;
            }
            add_fork_pane(state, id, fx);
        }
        ForkStage::Binding => {
            let op = state.ops.get_mut(&id).expect("the op");
            let workspace = op.workspace.clone();
            let Some(fork) = fork_mut(op) else { return };
            let pane = fork.pane;
            match outcome_of(op, |cmd| matches!(cmd, Cmd::ReportBinding { .. })).map(|outcome| outcome.cloned()) {
                None => {
                    op.send(Cmd::ReportBinding { workspace, pane, op: id });
                }
                Some(Some(Outcome::Applied { .. } | Outcome::Unchanged { .. })) => {
                    if let Some(fork) = fork_mut(op) {
                        fork.stage = ForkStage::Finishing;
                    }
                }
                Some(Some(_)) => {
                    if let Some(fork) = fork_mut(op) {
                        fork.stage = ForkStage::Undoing;
                    }
                }
                Some(None) => {
                    // Whichever comes first decides: the session's end before
                    // the binding is a fork that did not finish.
                    let ended = state.sessions.values().any(|row| row.owner.pane() == Some(pane) && row.ended);
                    let live = state.sessions.values().any(|row| row.owner.pane() == Some(pane) && !row.ended);
                    if ended && !live {
                        let op = state.ops.get_mut(&id).expect("the op");
                        if let Some(fork) = fork_mut(op) {
                            fork.stage = ForkStage::Undoing;
                        }
                    }
                }
            }
        }
        ForkStage::Finishing => {
            let op = &state.ops[&id];
            let Kind::Fork(fork) = &op.kind else { return };
            let scaffolding = fork.discard.as_ref().is_none_or(|discard| discard.once_started.is_empty());
            if (scaffolding || fork.done.contains(&Step::Discard) || fork.failed) && op.all_settled(saved) {
                finish(state, id);
            }
        }
        ForkStage::Undoing => undo_fork(state, id, fx),
    }
}

fn make_fork_team(state: &mut State, id: OpId, fx: &mut Fx) {
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    let Some(fork) = fork_mut(op) else { return };
    let Some(create) = fork.create.clone() else { return };
    let pane = fork.pane;
    let draft = fork.draft.clone();
    match outcome_of(op, |cmd| matches!(cmd, Cmd::AddTeam { .. })).map(|outcome| outcome.cloned()) {
        None => {
            let place = team_place(state, &workspace, &create, id);
            let op = state.ops.get_mut(&id).expect("the op");
            op.send(Cmd::AddTeam {
                workspace,
                team: create.team.clone(),
                draft: create.draft.clone(),
                place,
                members: vec![Member { pane, draft }],
            });
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(reason) = reason(&outcome) {
                answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
                if let Some(fork) = fork_mut(op) {
                    fork.stage = ForkStage::Undoing;
                }
                return;
            }
            if op.ask.is_some() {
                let minted = Minted { team: Some(create.team.clone()), panes: vec![pane], ..Minted::default() };
                answer_op(op, fx, Answer::Accepted { op: id, minted });
                let at = match &create.ticket {
                    Some(ticket) => TeamAt::Creating { op: id, ticket: ticket.clone() },
                    None => TeamAt::Attached {
                        cwd: match &create.site {
                            Site::Existing { cwd } => cwd.clone(),
                            _ => state.world.workspaces[&workspace].cwd.clone(),
                        },
                        branch: None,
                    },
                };
                state.world.teams.insert(create.team.clone(), Team { workspace: workspace.clone(), at });
                state.world.panes.insert(pane, Pane { workspace, team: Some(create.team.clone()), remote: false, suspended: false });
                let op = state.ops.get_mut(&id).expect("the op");
                let Some(fork) = fork_mut(op) else { return };
                fork.added = true;
                match fork.create.as_mut() {
                    Some(create) if create.worktree() => create.stage = CreateStage::Creating,
                    _ => fork.stage = ForkStage::Forking,
                }
                return;
            }
            let Some(fork) = fork_mut(op) else { return };
            if fork.create.as_ref().is_some_and(|create| create.created) {
                fork.stage = ForkStage::Forking;
            }
        }
    }
}

fn add_fork_pane(state: &mut State, id: OpId, fx: &mut Fx) {
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    let Some(fork) = fork_mut(op) else { return };
    let (team, pane, draft) = (fork.team.clone(), fork.pane, fork.draft.clone());
    if let Some(create) = fork.create.clone() {
        // Its team was made for it: the pane is there; the team now runs.
        match outcome_of(op, |cmd| matches!(cmd, Cmd::SettleTeam { .. })).map(|outcome| outcome.cloned()) {
            None => {
                let ticket = create.ticket.clone();
                let cwd = ticket.as_ref().map(|ticket| ticket.path.clone()).unwrap_or_else(|| state.world.workspaces[&workspace].cwd.clone());
                let branch = ticket.map(|ticket| ticket.branch);
                let op = state.ops.get_mut(&id).expect("the op");
                op.send(Cmd::SettleTeam { workspace, team, cwd, branch });
            }
            Some(None) => {}
            Some(Some(_)) => {
                if let Some(fork) = fork_mut(op) {
                    fork.stage = ForkStage::Binding;
                }
            }
        }
        return;
    }
    match outcome_of(op, |cmd| matches!(cmd, Cmd::AddPane { .. })).map(|outcome| outcome.cloned()) {
        None => {
            op.send(Cmd::AddPane { workspace, team, pane, draft });
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(reason) = reason(&outcome) {
                answer_op(op, fx, Answer::refused(Refusal::Rejected { reason }));
                if let Some(fork) = fork_mut(op) {
                    fork.stage = ForkStage::Undoing;
                }
                return;
            }
            answer_op(op, fx, Answer::Accepted { op: id, minted: Minted { panes: vec![pane], ..Minted::default() } });
            state.world.panes.insert(pane, Pane { workspace, team: Some(team), remote: false, suspended: false });
            let op = state.ops.get_mut(&id).expect("the op");
            if let Some(fork) = fork_mut(op) {
                fork.added = true;
                fork.stage = ForkStage::Binding;
            }
        }
    }
}

/// A fork that did not finish takes back all it made, once its hook has
/// really ended and nothing of its launch runs: both discard lists, the
/// worktree of the team made for it, its rows on the deck.
fn undo_fork(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    let Some(fork) = fork_mut(op) else { return };
    let fork = fork.clone();
    answer_op(op, fx, Answer::refused(if fork.expired { Refusal::ForkStepExpired } else { Refusal::Rejected { reason: "the fork did not finish".into() } }));
    if (fork.hook_sent && !fork.hook_ended) || fork_pane_busy(state, fork.pane) {
        return;
    }
    let made_team = fork.create.as_ref().filter(|create| create.ticket.is_some() || fork.added).map(|create| create.team.clone());
    // Its rows on the deck go.
    if fork.added {
        let op = state.ops.get_mut(&id).expect("the op");
        let cmd = match &made_team {
            Some(team) => Cmd::RemoveTeam { workspace: workspace.clone(), team: team.clone() },
            None => Cmd::RemovePane { workspace: workspace.clone(), pane: fork.pane },
        };
        if !op.sent.iter().any(|sent| sent.cmd == cmd) {
            op.send(cmd);
        }
        state.forgotten.panes.insert(fork.pane);
        if let Some(team) = &made_team {
            state.forgotten.teams.insert(team.clone());
        }
    }
    let steps_done = undo_steps(&fork).iter().all(|step| fork.done.contains(step)) || fork.failed;
    if !steps_done || !state.ops[&id].all_settled(saved) {
        return;
    }
    if fork.failed {
        state.ops.get_mut(&id).expect("the op").owed = true;
        return;
    }
    state.world.panes.remove(&fork.pane);
    if let Some(team) = made_team {
        state.world.teams.remove(&team);
    }
    finish(state, id);
}

fn undo_steps(fork: &Fork) -> Vec<Step> {
    let mut steps = Vec::new();
    if fork.discard.is_some() {
        steps.push(Step::Discard);
    }
    if let Some(ticket) = fork.create.as_ref().and_then(|create| create.ticket.as_ref()) {
        steps.push(Step::Checkout { path: ticket.path.clone() });
    }
    steps
}

pub fn work_fork(state: &State, id: OpId, op: &Op, fork: &Fork, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    if let Some(create) = &fork.create {
        owed = work_create(state, id, op, create, owed);
    }
    match fork.stage {
        ForkStage::Forking if fork.hook_sent && !fork.expired => {
            owed = owed.after(FORK_DEADLINE, Event::Timer(Timer::Fork { op: id }));
        }
        ForkStage::Finishing => {
            if let Some(discard) = &fork.discard {
                if !discard.once_started.is_empty() && !fork.done.contains(&Step::Discard) && !fork.failed {
                    let how = Clean::Discard { plugin: discard.plugin.clone(), paths: discard.once_started.clone() };
                    owed = owed.run(Effect::Clean { op: id, workspace: op.workspace.clone(), step: Step::Discard, how });
                }
            }
        }
        ForkStage::Undoing => {
            let quiet = !(fork.hook_sent && !fork.hook_ended) && !fork_pane_busy(state, fork.pane);
            if quiet && !fork.failed {
                for step in undo_steps(fork) {
                    if fork.done.contains(&step) {
                        continue;
                    }
                    let how = match &step {
                        Step::Discard => {
                            let discard = fork.discard.as_ref().expect("a discard");
                            let paths = discard.once_started.iter().chain(&discard.if_never_started).cloned().collect();
                            Clean::Discard { plugin: discard.plugin.clone(), paths }
                        }
                        Step::Checkout { path } => {
                            let repo = fork.create.as_ref().and_then(|create| create.ticket.as_ref()).map(|ticket| ticket.repo.clone());
                            let Some(repo) = repo else { continue };
                            Clean::Checkout { repo, path: path.clone() }
                        }
                        _ => continue,
                    };
                    owed = owed.run(Effect::Clean { op: id, workspace: op.workspace.clone(), step, how });
                }
            }
        }
        _ => {}
    }
    owed
}
