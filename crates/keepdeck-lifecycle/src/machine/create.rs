//! Making things: workspaces, teams with their places, seats, resumed and
//! forked conversations, relocations.
//!
//! A team in a new worktree gets its place from the machine — the first
//! number nobody holds, then the disk's word on it — and a ticket written to
//! the journal before `git worktree add`. A fork is finished only when its
//! pane's launch is bound to the fork's conversation; any other end takes
//! back everything the fork made.

use super::boundary::Boundary;
use super::{answer_op, durable, finish, Clean, Effect, Event, Fx, Kind, Op, State, StepResult, Timer, FORK_DEADLINE};
use crate::command::{Cmd, Member, Outcome, Revision, TeamPlace};
use crate::dir::Dir;
use crate::ids::{AttemptId, OpId, PaneId, SessionId, TeamId, WorkspaceId};
use crate::journal::{Discard, Step, Ticket, Work};
use crate::model::{Answer, Draft, Folder, Minted, Refusal, SessionKey, Site};
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
    /// The Close that took it over, this launch — the one its checkout is
    /// handed to once git says this ticket made it. None after a restore:
    /// nothing then proves the checkout this ticket's.
    #[serde(default)]
    pub taken_by: Option<OpId>,
    /// `git worktree add` has answered.
    pub created: bool,
    /// Restored, taken over by a close whose entry does not hold its
    /// checkout yet: git is asked whether the checkout stands, never to make
    /// one, before it is handed over.
    #[serde(default)]
    pub find_only: bool,
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
            taken_by: None,
            created: false,
            find_only: false,
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

    pub fn abandon(&mut self, by: OpId) {
        self.abandoned = true;
        self.taken_by = Some(by);
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

/// A member moved to the workspace's root team, under the role the person
/// picked there if its own cannot come along.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relocate {
    pub pane: PaneId,
    pub from: Option<TeamId>,
    pub to: TeamId,
    pub new_root: bool,
    #[serde(default)]
    pub role: Option<String>,
}

impl Relocate {
    pub fn new(pane: PaneId, from: Option<TeamId>, to: TeamId, new_root: bool, role: Option<String>) -> Relocate {
        Relocate { pane, from, to, new_root, role }
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
    /// Taken back: the launches admitted into its checkout before, taken to
    /// the start boundary.
    #[serde(default)]
    pub boundary: Boundary,
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
            boundary: Boundary::default(),
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

/// The ops that change a team's membership and have not settled it yet. A
/// fork changes it from its acceptance: placing and making the team it lands
/// on are part of bringing its pane in, so a Close begun meanwhile waits
/// for it, as for any other landing. One rolling back after its first
/// journal write failed brings nothing in.
pub fn membership_pending(op: &Op, saved: Option<Revision>) -> bool {
    let unsettled = |pred: fn(&Cmd) -> bool| op.sent.iter().any(|sent| pred(&sent.cmd) && !sent.settled(saved));
    match &op.kind {
        Kind::Seat(_) => op.ask.is_some() || unsettled(|cmd| matches!(cmd, Cmd::AddPane { .. })),
        Kind::Relocate(_) => op.ask.is_some() || unsettled(|cmd| matches!(cmd, Cmd::MovePane { .. })),
        Kind::Fork(fork) => match fork.stage {
            ForkStage::Placing | ForkStage::Journaling | ForkStage::Making | ForkStage::Forking => !fork.expired,
            ForkStage::RollingBack => false,
            ForkStage::Adding => true,
            ForkStage::Binding | ForkStage::Finishing | ForkStage::Undoing => unsettled(|cmd| matches!(cmd, Cmd::AddPane { .. })),
        },
        _ => false,
    }
}

/// The pane an additive operation is still bringing in, and the team it
/// lands on — while its membership is not settled. A Close begun now waits
/// for it and takes it, so the Close's dialog shows it.
pub fn landing(op: &Op, saved: Option<Revision>) -> Option<(TeamId, PaneId)> {
    if !membership_pending(op, saved) {
        return None;
    }
    match &op.kind {
        Kind::Seat(seat) => Some((seat.team.clone(), seat.pane)),
        Kind::Fork(fork) => Some((fork.team.clone(), fork.pane)),
        Kind::Relocate(relocate) => Some((relocate.to.clone(), relocate.pane)),
        _ => None,
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
/// A creation holds its place — its ticket's folder, or the one it probes —
/// until a Close takes it over: then the place is the close's, deleted by
/// its consent or kept.
pub fn holds_folder(op: &Op, dir: &Dir) -> bool {
    create_of(op).is_some_and(|create| {
        !create.abandoned
            && (create.ticket.as_ref().is_some_and(|ticket| &ticket.path == dir) || create.probing.as_ref().is_some_and(|(path, _)| path == dir))
    })
}

/// A creation of one of these teams is still in `git worktree add`.
pub fn still_creating_for(op: &Op, teams: &[TeamId]) -> bool {
    create_of(op).is_some_and(|create| teams.contains(&create.team) && create.stage == CreateStage::Creating && !create.created)
}

/// The repository a workspace's branch names are unique within, while its
/// row stands.
fn space_of<'a>(state: &'a State, workspace: &WorkspaceId) -> Option<&'a Dir> {
    state.world.workspaces.get(workspace).map(|row| row.branch_space())
}

/// Whether a branch reserved in `theirs` counts against a new one in
/// `mine`: one repository. A reservation that does not know its repository
/// (an entry written before it was kept) is held against every one: a name
/// withheld costs nothing, a branch given twice costs a checkout.
fn counts(mine: Option<&Dir>, theirs: Option<&Dir>) -> bool {
    match (mine, theirs) {
        (Some(mine), Some(theirs)) => mine == theirs,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// Whether `owner`'s branches count against `asking`'s: checkouts of one
/// repository.
pub(super) fn shares_branches(state: &State, asking: &WorkspaceId, owner: &WorkspaceId) -> bool {
    counts(space_of(state, asking), space_of(state, owner))
}

/// Every folder and branch held against a place for `workspace`. A path is
/// one place on disk, so every workspace's count. A branch name is unique
/// within a repository: the branches of every workspace on the same one —
/// its folder opened twice, or two of its worktrees — count, and an
/// unrelated repository's do not. A close's are counted by the repository
/// it keeps with them, its workspace's row gone or not.
pub(super) fn held(state: &State, workspace: &WorkspaceId) -> Held {
    let mine = space_of(state, workspace);
    let mut held = Held::default();
    let mut hold = |path: &Dir, branches: &mut dyn Iterator<Item = String>, theirs: Option<&Dir>| {
        held.paths.insert(path.clone());
        if counts(mine, theirs) {
            held.branches.extend(branches);
        }
    };
    for team in state.world.teams.values() {
        let theirs = space_of(state, &team.workspace);
        match &team.at {
            TeamAt::Attached { cwd, branch } => hold(cwd, &mut branch.clone().into_iter(), theirs),
            TeamAt::Creating { ticket, .. } | TeamAt::Failed { ticket } => hold(&ticket.path, &mut std::iter::once(ticket.branch.clone()), theirs),
            TeamAt::Unplaced => {}
        }
    }
    for op in state.ops.values() {
        if let Some(create) = create_of(op) {
            let theirs = space_of(state, &op.workspace);
            if let Some(ticket) = &create.ticket {
                hold(&ticket.path, &mut std::iter::once(ticket.branch.clone()), theirs);
            }
            if let Some((path, branch)) = &create.probing {
                hold(path, &mut std::iter::once(branch.clone()), theirs);
            }
        }
        if let Some(teardown) = op.teardown() {
            let theirs = teardown.space.as_ref();
            for removal in &teardown.removals {
                hold(&removal.path, &mut removal.branches.iter().cloned(), theirs);
            }
            for folder in &teardown.consent.folders {
                hold(&folder.path, &mut folder.branch.clone().into_iter(), theirs);
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

/// A taken-over creation's checkout, proved this ticket's, goes to the close
/// that took it — as one of the folders it may delete, when the person
/// agreed to the creation's ticket. Its entry carries it from here.
fn hand_over(state: &mut State, close: OpId, creation: OpId, ticket: Ticket) {
    let Some(teardown) = state.ops.get_mut(&close).and_then(Op::teardown_mut) else { return };
    let consent = &mut teardown.consent;
    if consent.tickets.contains(&creation) && !consent.folders.iter().any(|folder| folder.path == ticket.path) {
        consent.folders.push(Folder { repo: ticket.repo, path: ticket.path, branch: Some(ticket.branch) });
    }
}

/// Whether a taken-over creation may let its entry go: the checkout it
/// handed to its close is on that close's entry on disk — or it handed
/// nothing. Until then its own entry is the trace of a checkout the close
/// is to delete, and a crash must not lose both.
fn handed_over(state: &State, create: &Create) -> bool {
    let (Some(close), Some(ticket)) = (create.taken_by, &create.ticket) else { return true };
    let Some(op) = state.ops.get(&close) else { return true };
    let Some(teardown) = op.teardown() else { return true };
    if !teardown.consent.folders.iter().any(|folder| folder.path == ticket.path) {
        return true;
    }
    let written = op.book.as_ref().and_then(|book| book.written.as_ref());
    written.is_some_and(|entry| matches!(&entry.work, Work::Close { consent, .. } if consent.folders.iter().any(|folder| folder.path == ticket.path)))
}

/// Git's word on a restored, taken-over creation's checkout. Standing, it
/// is handed over as a made one is; not standing, nothing is. When git
/// could not read the repository nothing is known: the creation and the
/// close that took it over are both owed, their entries kept, and the next
/// launch joins them and asks again.
pub fn found(state: &mut State, id: OpId, found: Result<bool, String>, fx: &mut Fx) {
    match found {
        Ok(true) => created(state, id, Ok(()), fx),
        Ok(false) => created(state, id, Err("no checkout of this ticket stands at its path".into()), fx),
        Err(reason) => {
            let Some(op) = state.ops.get_mut(&id) else { return };
            let Some(create) = create_mut(op) else { return };
            if create.stage != CreateStage::Creating || create.created {
                return;
            }
            let taker = create.taken_by;
            fx.warn(format!("{id}: whether its checkout stands is not known: {reason}"));
            op.owed = true;
            if let Some(close) = taker.and_then(|close| state.ops.get_mut(&close)) {
                close.owed = true;
            }
        }
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
        // Git says this ticket made the checkout: the close that took the
        // creation over may delete it, if the person agreed. Anything else —
        // the path another checkout's, git refusing — hands nothing over.
        if let (Ok(()), Some(by)) = (&result, create.taken_by) {
            hand_over(state, by, id, ticket);
        }
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

/// The owner's refusal an outcome carries, if it is one.
fn refused(outcome: &Outcome) -> Option<Refusal> {
    match outcome {
        Outcome::Rejected { why } => Some(Refusal::Rejected { why: why.clone() }),
        _ => None,
    }
}

pub fn advance_workspace(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    if let Some(Some(outcome)) = outcome_of(op, |cmd| matches!(cmd, Cmd::AddWorkspace { .. })) {
        if let Some(refusal) = refused(outcome) {
            answer_op(op, fx, Answer::refused(refusal));
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
            if durable(id, &state.ops[&id], state.saved) {
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
                if create.abandoned && create.created && handed_over(state, create) {
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
                if let Some(refusal) = refused(outcome) {
                    answer_op(op, fx, Answer::refused(refusal));
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
                let Some(place) = team_place(state, &workspace, &create, id) else { return workspace_gone(state, id, fx) };
                Cmd::AddTeam { workspace: workspace.clone(), team: create.team.clone(), draft: create.draft.clone(), place, members: create.members.clone() }
            };
            let op = state.ops.get_mut(&id).expect("the op");
            op.send(cmd);
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(refusal) = refused(outcome) {
                answer_op(op, fx, Answer::refused(refusal));
                finish(state, id);
                return;
            }
            let Some(at) = made_team_at(state, &workspace, &create, id) else { return workspace_gone(state, id, fx) };
            let minted = Minted {
                team: Some(create.team.clone()),
                panes: create.members.iter().map(|member| member.pane).collect(),
                ..Minted::default()
            };
            let op = state.ops.get_mut(&id).expect("the op");
            answer_op(op, fx, Answer::Accepted { op: id, minted });
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

/// Where a made team goes on the deck: its ticket's checkout, or the folder
/// it attaches to. None once its workspace is gone.
fn team_place(state: &State, workspace: &WorkspaceId, create: &Create, id: OpId) -> Option<TeamPlace> {
    Some(match &create.ticket {
        Some(ticket) => TeamPlace::Provisioning { op: id, path: ticket.path.clone(), branch: ticket.branch.clone(), base: ticket.base.clone() },
        None => TeamPlace::Attached { cwd: attached_cwd(state, workspace, &create.site)?, branch: None },
    })
}

/// Where a made team runs once the deck holds it: its ticket's checkout,
/// being created, or the folder it attaches to. None once its workspace is
/// gone.
fn made_team_at(state: &State, workspace: &WorkspaceId, create: &Create, id: OpId) -> Option<TeamAt> {
    Some(match &create.ticket {
        Some(ticket) => TeamAt::Creating { op: id, ticket: ticket.clone() },
        None => TeamAt::Attached { cwd: attached_cwd(state, workspace, &create.site)?, branch: None },
    })
}

/// The folder a team that makes no worktree runs in: the one its site names,
/// or its workspace's own. None once the workspace is gone.
fn attached_cwd(state: &State, workspace: &WorkspaceId, site: &Site) -> Option<Dir> {
    match site {
        Site::Existing { cwd } => Some(cwd.clone()),
        Site::Root | Site::New { .. } => state.world.workspaces.get(workspace).map(|row| row.cwd.clone()),
    }
}

/// The workspace an operation adds to is gone: an owner answered after its
/// close, or out of order. Nothing more is added to it. The operation is
/// refused and owed: it neither runs on nor ends, and what it journaled is
/// taken up by the next launch.
fn workspace_gone(state: &mut State, id: OpId, fx: &mut Fx) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    fx.warn(format!("{id}: its workspace is gone; nothing more is added to it"));
    answer_op(op, fx, Answer::refused(Refusal::NotFound));
    op.owed = true;
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
            let (op, ticket) = (id, ticket.clone());
            owed = owed.run(if create.find_only { Effect::FindWorktree { op, ticket } } else { Effect::CreateWorktree { op, ticket } });
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
                _ => Clean::Branch { repo: ticket.repo.clone(), name: ticket.branch.clone() },
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
                if let Some(refusal) = refused(outcome) {
                    answer_op(op, fx, Answer::refused(refusal));
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
            if let Some(refusal) = refused(outcome) {
                if op.ask.is_some() && seat.resume.is_some() {
                    // The plan built for it has nowhere to run.
                    op.send(Cmd::Retire { workspace, pane: seat.pane });
                }
                answer_op(op, fx, Answer::refused(refusal));
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
            op.send(Cmd::MovePane {
                workspace,
                pane: relocate.pane,
                to: relocate.to.clone(),
                new_root: relocate.new_root,
                role: relocate.role.clone(),
            });
        }
        Some(None) => {}
        Some(Some(outcome)) => {
            if let Some(refusal) = refused(outcome) {
                answer_op(op, fx, Answer::refused(refusal));
            } else if op.ask.is_some() {
                // A new root team runs in the workspace's own folder.
                let root = attached_cwd(state, &workspace, &Site::Root);
                if relocate.new_root && root.is_none() {
                    return workspace_gone(state, id, fx);
                }
                let op = state.ops.get_mut(&id).expect("the op");
                answer_op(op, fx, Answer::Accepted { op: id, minted: Minted::default() });
                if let (true, Some(cwd)) = (relocate.new_root, root) {
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

/// The folder the fork carries the conversation into: the worktree its new
/// team's ticket makes, or else its team's own folder — an existing team's,
/// or a new team's placed on the root or on a folder that is there.
fn fork_cwd(state: &State, fork: &Fork) -> Option<Dir> {
    match fork.create.as_ref().and_then(|create| create.ticket.as_ref()) {
        Some(ticket) => Some(ticket.path.clone()),
        None => state.world.team_cwd(&fork.team),
    }
}

/// The live sessions in the fork's own checkout, its pane's aside — what the
/// hook started there. They stop before the checkout goes.
fn fork_folder_sessions(state: &State, fork: &Fork) -> Vec<SessionId> {
    let Some(ticket) = fork.create.as_ref().and_then(|create| create.ticket.as_ref()) else { return Vec::new() };
    state
        .sessions
        .iter()
        .filter(|(_, row)| !row.ended && row.dir.as_ref() == Some(&ticket.path) && row.owner.pane() != Some(fork.pane))
        .map(|(&session, _)| session)
        .collect()
}

/// The fork's checkout may go: nothing runs in it, and every launch admitted
/// into it is settled at the start boundary — its own, or another's.
fn fork_folder_quiet(state: &State, fork: &Fork) -> bool {
    let Some(ticket) = fork.create.as_ref().and_then(|create| create.ticket.as_ref()) else { return true };
    let elsewhere = |attempt: &AttemptId| !fork.boundary.taken.contains(attempt) && !fork.boundary.started.contains(attempt);
    let others = state.attempts.iter().any(|(attempt, row)| row.dir.as_ref() == Some(&ticket.path) && elsewhere(attempt));
    state.sessions_down || (fork_folder_sessions(state, fork).is_empty() && fork.boundary.settled(&state.attempts) && !others)
}

/// The launches admitted into a fork's checkout before it was taken back
/// go to its start boundary: cancelled there, or awaited and stopped.
fn take_to_boundary(state: &mut State, id: OpId) {
    let State { ops, attempts, .. } = state;
    let Some(fork) = ops.get_mut(&id).and_then(fork_mut) else { return };
    let Some(path) = fork.create.as_ref().and_then(|create| create.ticket.as_ref()).map(|ticket| ticket.path.clone()) else { return };
    fork.boundary.take(attempts, id, |row| row.dir.as_ref() == Some(&path));
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
            if durable(id, &state.ops[&id], state.saved) {
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
                    // A step that answered with no conversation carried
                    // refused it, in its own kind, or did not finish it.
                    let refusal = refused(&outcome).unwrap_or(Refusal::ForkUnfinished);
                    fork.stage = ForkStage::Undoing;
                    answer_op(op, fx, Answer::refused(refusal));
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
            let Some(place) = team_place(state, &workspace, &create, id) else { return workspace_gone(state, id, fx) };
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
            if let Some(refusal) = refused(&outcome) {
                answer_op(op, fx, Answer::refused(refusal));
                if let Some(fork) = fork_mut(op) {
                    fork.stage = ForkStage::Undoing;
                }
                return;
            }
            if op.ask.is_some() {
                let Some(at) = made_team_at(state, &workspace, &create, id) else { return workspace_gone(state, id, fx) };
                let minted = Minted { team: Some(create.team.clone()), panes: vec![pane], ..Minted::default() };
                let op = state.ops.get_mut(&id).expect("the op");
                answer_op(op, fx, Answer::Accepted { op: id, minted });
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
                let (cwd, branch) = match create.ticket {
                    Some(ticket) => (ticket.path, Some(ticket.branch)),
                    None => match attached_cwd(state, &workspace, &create.site) {
                        Some(cwd) => (cwd, None),
                        None => return workspace_gone(state, id, fx),
                    },
                };
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
            if let Some(refusal) = refused(&outcome) {
                answer_op(op, fx, Answer::refused(refusal));
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

/// The fork's hook is done with, both ways: its call has ended and its
/// answer is in — the two arrive apart, in either order, and a late answer
/// carries the lists of what it made.
fn hook_settled(op: &Op, fork: &Fork) -> bool {
    !fork.hook_sent || (fork.hook_ended && outcome_of(op, |cmd| matches!(cmd, Cmd::Fork { .. })).flatten().is_some())
}

/// A fork that did not finish takes back all it made, once its hook has
/// really ended and nothing of its launch runs: both discard lists, the
/// worktree of the team made for it, its rows on the deck.
fn undo_fork(state: &mut State, id: OpId, fx: &mut Fx) {
    let saved = state.saved;
    take_to_boundary(state, id);
    let op = state.ops.get_mut(&id).expect("the op");
    let workspace = op.workspace.clone();
    // The hook's own result, late — after its deadline turned the fork back:
    // what it made is still to be taken back, its lists to the journal first.
    let late = match outcome_of(op, |cmd| matches!(cmd, Cmd::Fork { .. })) {
        Some(Some(Outcome::Forked { discard })) => Some(discard.clone()),
        _ => None,
    };
    let Some(fork) = fork_mut(op) else { return };
    if fork.discard.is_none() {
        fork.discard = late;
    }
    let fork = fork.clone();
    answer_op(op, fx, Answer::refused(if fork.expired { Refusal::ForkStepExpired } else { Refusal::ForkUnfinished }));
    if !hook_settled(&state.ops[&id], &fork) || fork_pane_busy(state, fork.pane) {
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
            // The launches it took over are cancelled at the boundary at once.
            owed = fork.boundary.work(id, owed);
            let quiet = hook_settled(op, fork) && !fork_pane_busy(state, fork.pane);
            if quiet && !fork.failed {
                // What the hook started in the checkout stops before anything
                // of it goes; the scope keeps anything new from starting there.
                for session in fork_folder_sessions(state, fork) {
                    owed = owed.run(Effect::Stop { session });
                }
                let recorded = op.book.as_ref().and_then(|book| book.written.as_ref()).is_some_and(|entry| matches!(&entry.work, Work::Fork { discard: Some(_), .. }));
                let discarded = fork.discard.is_none() || fork.done.contains(&Step::Discard);
                let folder_quiet = fork_folder_quiet(state, fork);
                for step in undo_steps(fork) {
                    if fork.done.contains(&step) {
                        continue;
                    }
                    let how = match &step {
                        Step::Discard => {
                            // The lists reach the journal before anything goes,
                            // and nothing of the hook runs while they go.
                            if !recorded || !folder_quiet {
                                continue;
                            }
                            let discard = fork.discard.as_ref().expect("a discard");
                            let paths = discard.once_started.iter().chain(&discard.if_never_started).cloned().collect();
                            Clean::Discard { plugin: discard.plugin.clone(), paths }
                        }
                        Step::Checkout { path } => {
                            // One step after the other: the scaffolding first, and
                            // nothing running in the checkout, nor about to.
                            if !discarded || !folder_quiet {
                                continue;
                            }
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
