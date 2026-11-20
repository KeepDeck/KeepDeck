//! The lifecycle machine: its state, its events and effects, and the two pure
//! functions the runtime calls — `update` for an event, `work` for what a
//! state needs.
//!
//! `update` applies the event, then lets every operation advance as far as
//! the state now allows (`settle`): an operation's next step depends on facts
//! — a durable deck command, the last session of its team ended — and not on
//! which event made them true, so the order events arrive in changes nothing.

mod boot;
mod capture;
mod create;
mod launch;
pub mod queries;
pub mod snapshot;
mod teardown;

use crate::command::{Cmd, Command, Outcome, Owner, Revision};
use crate::dir::Dir;
use crate::ids::{AskId, AttemptId, CommandId, Counter, OpId, PaneId, PermitId, SessionId, TeamId, WorkspaceId};
use crate::journal::{Entry, Step, Ticket};
use crate::model::{Answer, Intent, Refusal};
use crate::world::{DeckFacts, World};
use keepdeck_fsm::{stay, to, Next, Owed};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

pub use boot::Load;
pub use create::{Create, CreateStage, Fork, ForkStage};
pub use launch::{Attempt, LaunchOwner, LeaseAsk, Permit, Session, SessionOwner};
pub use teardown::{TearPhase, Teardown};

/// How long a Close waits for the launch state to answer «retire».
pub const RETIRE_WAIT: Duration = Duration::from_secs(2);
/// How long a Close waits for planting leases given before it.
pub const LEASE_WAIT: Duration = Duration::from_secs(5);
/// How long a Close waits for a session whose process exists to show up.
pub const REGISTRATION_WAIT: Duration = Duration::from_secs(5);
/// How long a launch permit lives unspent.
pub const PERMIT_LIFE: Duration = Duration::from_secs(30);
/// How long the fork step's hook may take to answer.
pub const FORK_DEADLINE: Duration = Duration::from_secs(120);

/// What has been forgotten — only grows. A write whose source is here is
/// refused at its commit; what was accepted before is removed by the
/// operation's cleanup.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Forgotten {
    pub workspaces: BTreeSet<WorkspaceId>,
    pub teams: BTreeSet<TeamId>,
    pub panes: BTreeSet<PaneId>,
}

impl Forgotten {
    /// The commit check: a write from this source is refused. The source is
    /// the writer's trusted one — its workspace and, when it has them, its
    /// team and pane — so the check needs nothing but the set.
    pub fn source(&self, workspace: &WorkspaceId, team: Option<&TeamId>, pane: Option<&PaneId>) -> bool {
        self.workspaces.contains(workspace)
            || team.is_some_and(|team| self.teams.contains(team))
            || pane.is_some_and(|pane| self.panes.contains(pane))
    }

    pub fn pane(&self, world: &World, pane: &PaneId) -> bool {
        if self.panes.contains(pane) {
            return true;
        }
        world.panes.get(pane).is_some_and(|row| {
            self.workspaces.contains(&row.workspace) || row.team.as_ref().is_some_and(|team| self.teams.contains(team))
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counters {
    pub pane: Counter,
    pub op: Counter,
    pub permit: Counter,
    pub attempt: Counter,
}

/// A command an operation sent, and its owner's answer when it came.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    pub cmd: Cmd,
    pub outcome: Option<Outcome>,
}

impl Sent {
    pub fn new(cmd: Cmd) -> Sent {
        Sent { cmd, outcome: None }
    }

    /// Settled: answered — and a deck command applied, also on disk.
    pub fn settled(&self, saved: Option<Revision>) -> bool {
        match (&self.outcome, self.cmd.owner()) {
            (None, _) => false,
            (Some(Outcome::Rejected { .. }), _) => true,
            (Some(outcome), Owner::Deck) => match outcome.revision() {
                Some(revision) => saved.is_some_and(|saved| saved >= revision),
                None => true,
            },
            (Some(_), _) => true,
        }
    }

    pub fn rejected(&self) -> Option<&str> {
        match &self.outcome {
            Some(Outcome::Rejected { reason }) => Some(reason),
            _ => None,
        }
    }
}

/// The journal side of an operation: what is on disk, and the write or
/// removal on its way. Writes go one at a time: the next starts only once
/// the previous one's result is in.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Book {
    pub written: Option<Entry>,
    pub flying: Option<(u32, Entry)>,
    pub removing: Option<u32>,
    pub attempts: u32,
}

/// One operation of the machine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub workspace: WorkspaceId,
    /// The door waiting for this operation's answer; gone once answered, and
    /// absent for an operation restored from the journal.
    pub ask: Option<AskId>,
    /// Journaled operations only.
    pub book: Option<Book>,
    pub sent: Vec<Sent>,
    pub kind: Kind,
    /// A step of its own failed this launch: it waits for the next one.
    pub owed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Kind {
    CreateWorkspace,
    Create(Box<Create>),
    /// A pane added to a team: a seat, or a resume.
    Seat(create::Seat),
    Fork(Box<Fork>),
    Relocate(create::Relocate),
    Teardown(Box<Teardown>),
    Restore,
    Resume { pane: PaneId },
    RemoveUnheld(teardown::Unheld),
    Reconcile(boot::Reconcile),
}

impl Op {
    pub fn new(workspace: WorkspaceId, ask: AskId, journaled: bool, kind: Kind) -> Op {
        Op { workspace, ask: Some(ask), book: journaled.then(Book::default), sent: Vec::new(), kind, owed: false }
    }

    /// Send a command; its id is its place among this operation's commands.
    pub fn send(&mut self, cmd: Cmd) -> usize {
        self.sent.push(Sent::new(cmd));
        self.sent.len() - 1
    }

    pub fn all_settled(&self, saved: Option<Revision>) -> bool {
        self.sent.iter().all(|sent| sent.settled(saved))
    }

    /// The entry this operation wants on disk now. A command is written
    /// settled by the one rule that settles it here — a deck command once its
    /// revision is saved — so a crash between the owner's answer and the
    /// deck's save asks it again; a refusal keeps its reason.
    pub fn entry(&self, id: OpId, saved: Option<Revision>) -> Option<Entry> {
        let work = match &self.kind {
            Kind::Create(create) => create.journaled()?,
            Kind::Fork(fork) => fork.journaled(),
            Kind::Teardown(teardown) => teardown.journaled()?,
            Kind::RemoveUnheld(unheld) => unheld.journaled(),
            Kind::CreateWorkspace | Kind::Seat(_) | Kind::Relocate(_) | Kind::Restore | Kind::Resume { .. } | Kind::Reconcile(_) => {
                return None
            }
        };
        let commands = self
            .sent
            .iter()
            .enumerate()
            .map(|(index, sent)| crate::journal::Sent {
                command: Command { id: CommandId { op: id, index: index as u32 }, cmd: sent.cmd.clone() },
                settled: sent.settled(saved),
                rejected: sent.rejected().map(str::to_owned),
            })
            .collect();
        let (joined, done) = match &self.kind {
            Kind::Teardown(teardown) => (teardown.joined.clone(), teardown.done.clone()),
            Kind::RemoveUnheld(unheld) => (Vec::new(), unheld.done.clone()),
            Kind::Fork(fork) => (Vec::new(), fork.done.clone()),
            _ => (Vec::new(), Vec::new()),
        };
        Some(Entry { op: id, workspace: self.workspace.clone(), work, joined, commands, done })
    }
}

/// The lifecycle machine's state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub boot: boot::Boot,
    /// The sessions machine is gone: nothing launches until a restart.
    pub sessions_down: bool,
    pub world: World,
    pub ops: BTreeMap<OpId, Op>,
    pub forgotten: Forgotten,
    pub permits: BTreeMap<PermitId, Permit>,
    pub attempts: BTreeMap<AttemptId, Attempt>,
    pub sessions: BTreeMap<SessionId, Session>,
    /// The highest deck revision reported saved.
    pub saved: Option<Revision>,
    pub next: Counters,
}

/// A timer of the machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Timer {
    Retire { op: OpId },
    Leases { op: OpId },
    Registration { op: OpId },
    Permit { permit: PermitId },
    Fork { op: OpId },
}

/// The result of a git or store step.
pub type StepResult = Result<(), String>;

/// What happened.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// The boot handshake: the deck's facts, and how it loaded.
    Handshake { ask: AskId, deck: DeckFacts, load: Load },
    Intent { ask: AskId, intent: Intent },
    Lease { ask: AskId, lease: LeaseAsk },
    /// A planting lease handed back, or a launch that did not start.
    Release { permit: PermitId },
    /// The spawn door spends a permit, just before the launch.
    Admit { ask: AskId, permit: PermitId, owner: LaunchOwner, dir: Option<Dir> },
    /// The spawn door: this admitted launch did not start.
    NotStarted { attempt: AttemptId },
    /// An owner's answer to a command.
    Answered { id: CommandId, outcome: Outcome },
    DeckSaved { revision: Revision },
    /// The fork step: the hook call has really ended.
    HookEnded { op: OpId },
    JournalWritten { op: OpId, attempt: u32, result: StepResult },
    JournalRemoved { op: OpId, attempt: u32, result: StepResult },
    /// What is on disk at a candidate place.
    Probed { op: OpId, path: Dir, taken: bool },
    Created { op: OpId, result: StepResult },
    BranchesRead { op: OpId, path: Dir, result: Result<Vec<String>, String> },
    StepDone { op: OpId, step: Step, result: StepResult },
    /// The spawn door's start boundary, for the attempts a Close took over.
    Cancelled { op: OpId, started: Vec<AttemptId> },
    SessionAppeared { session: SessionId, attempt: Option<AttemptId>, owner: SessionOwner, dir: Option<Dir> },
    SessionEnded { session: SessionId },
    SessionsGone,
    Timer(Timer),
}

/// What the handler does in the world.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Effect {
    Answer { ask: AskId, answer: Answer },
    WriteJournal { op: OpId, attempt: u32, entry: Box<Entry> },
    RemoveJournal { op: OpId, attempt: u32 },
    Probe { op: OpId, repo: Dir, path: Dir, branch: String },
    CreateWorktree { op: OpId, ticket: Ticket },
    ReadBranches { op: OpId, repo: Dir, path: Dir },
    /// One removal or cleanup step; its result comes back as `StepDone`.
    Clean { op: OpId, workspace: WorkspaceId, step: Step, how: Clean },
    /// Stop this exact session, by the sessions machine's one stop rule.
    Stop { session: SessionId },
    /// Cancel these admitted launches at the spawn door's start boundary.
    Cancel { op: OpId, attempts: Vec<AttemptId> },
    Warn { message: String },
}

/// What a cleanup step needs to be done.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Clean {
    Checkout { repo: Dir, path: Dir },
    /// A branch the consent covers; kept if it is checked out elsewhere.
    Branch { repo: Dir, name: String },
    Disarm { dir: Dir },
    Stores,
    /// A checkout's HEAD kept as a tag; a tag name in use is refused.
    TagHead { repo: Dir, path: Dir, tag: String },
    Discard { plugin: String, paths: Vec<String> },
    /// Boot's reconciliation: the stores keep only these workspaces' data.
    Retain { workspaces: Vec<WorkspaceId> },
}

impl State {
    /// A machine started at app setup, before the deck has loaded. Without
    /// the journal root's claim (`journal: None`) another KeepDeck owns this
    /// settings folder, and this one only shows.
    pub fn start(journal: Option<Vec<Entry>>) -> State {
        let next = Counters {
            op: Counter::above(journal.iter().flatten().map(|entry| entry.op.0)),
            ..Counters::default()
        };
        State {
            boot: match journal {
                Some(entries) => boot::Boot::Waiting { journal: entries },
                None => boot::Boot::ViewOnly,
            },
            sessions_down: false,
            world: World::default(),
            ops: BTreeMap::new(),
            forgotten: Forgotten::default(),
            permits: BTreeMap::new(),
            attempts: BTreeMap::new(),
            sessions: BTreeMap::new(),
            saved: None,
            next,
        }
    }

    pub fn mint_op(&mut self) -> OpId {
        let (n, next) = self.next.op.next();
        self.next.op = next;
        OpId(n)
    }

    pub fn mint_pane(&mut self) -> PaneId {
        let (n, next) = self.next.pane.next();
        self.next.pane = next;
        PaneId(n)
    }

    /// The barrier is down: launches, removals and new operations may go.
    pub fn open(&self) -> bool {
        self.boot.open()
    }
}

/// Effects of one step, collected.
pub struct Fx(Vec<Effect>);

impl Fx {
    pub fn answer(&mut self, ask: AskId, answer: Answer) {
        self.0.push(Effect::Answer { ask, answer });
    }

    pub fn warn(&mut self, message: String) {
        self.0.push(Effect::Warn { message });
    }
}

/// Answer an operation's door, once.
pub fn answer_op(op: &mut Op, fx: &mut Fx, answer: Answer) {
    if let Some(ask) = op.ask.take() {
        fx.answer(ask, answer);
    }
}

pub fn update(state: &State, event: Event) -> Next<State, Effect> {
    let mut next = state.clone();
    let mut fx = Fx(Vec::new());
    step(&mut next, event, &mut fx);
    settle(&mut next, &mut fx);
    let mut out = if &next == state { stay() } else { to(next) };
    for effect in fx.0 {
        out = out.run(effect);
    }
    out
}

fn step(state: &mut State, event: Event, fx: &mut Fx) {
    match event {
        Event::Handshake { ask, deck, load } => boot::handshake(state, ask, deck, load, fx),
        Event::Intent { ask, intent } => capture::intent(state, ask, intent, fx),
        Event::Lease { ask, lease } => launch::lease(state, ask, lease, fx),
        Event::Release { permit } => {
            state.permits.remove(&permit);
        }
        Event::Admit { ask, permit, owner, dir } => launch::admit(state, ask, permit, owner, dir, fx),
        Event::NotStarted { attempt } => {
            state.attempts.remove(&attempt);
        }
        Event::Answered { id, outcome } => {
            if let Some(op) = state.ops.get_mut(&id.op) {
                if let Some(sent) = op.sent.get_mut(id.index as usize) {
                    if sent.outcome.is_none() {
                        sent.outcome = Some(outcome);
                    }
                }
            }
        }
        Event::DeckSaved { revision } => {
            state.saved = state.saved.max(Some(revision));
        }
        Event::HookEnded { op } => {
            if let Some(Kind::Fork(fork)) = state.ops.get_mut(&op).map(|op| &mut op.kind) {
                fork.hook_ended = true;
            }
        }
        Event::JournalWritten { op, attempt, result } => journal_written(state, op, attempt, result, fx),
        Event::JournalRemoved { op, attempt, result } => journal_removed(state, op, attempt, result, fx),
        Event::Probed { op, path, taken } => create::probed(state, op, path, taken, fx),
        Event::Created { op, result } => create::created(state, op, result, fx),
        Event::BranchesRead { op, path, result } => teardown::branches_read(state, op, path, result, fx),
        Event::StepDone { op, step, result } => teardown::step_done(state, op, step, result, fx),
        Event::Cancelled { op, started } => teardown::cancelled(state, op, started),
        Event::SessionAppeared { session, attempt, owner, dir } => launch::appeared(state, session, attempt, owner, dir),
        Event::SessionEnded { session } => {
            if let Some(row) = state.sessions.get_mut(&session) {
                row.ended = true;
            }
        }
        Event::SessionsGone => {
            state.sessions_down = true;
            for row in state.sessions.values_mut() {
                row.ended = true;
            }
        }
        Event::Timer(timer) => self::timer(state, timer),
    }
}

fn timer(state: &mut State, timer: Timer) {
    match timer {
        Timer::Permit { permit } => {
            state.permits.remove(&permit);
        }
        Timer::Retire { op } | Timer::Leases { op } | Timer::Registration { op } => teardown::waited(state, op, &timer),
        Timer::Fork { op } => create::fork_deadline(state, op),
    }
}

fn journal_written(state: &mut State, id: OpId, attempt: u32, result: StepResult, fx: &mut Fx) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let Some(book) = op.book.as_mut() else { return };
    let Some((flying, entry)) = book.flying.take_if(|(flying, _)| *flying == attempt) else { return };
    match result {
        Ok(()) => book.written = Some(entry),
        Err(error) => {
            fx.warn(format!("{id}: the journal entry was not written ({error}) — attempt {flying}"));
            if book.written.is_none() {
                // Nothing of the operation is on disk yet, but the file may
                // be: take it back before letting the capture go.
                book.attempts += 1;
                book.removing = Some(book.attempts);
                rollback(op);
            } else {
                op.owed = true;
            }
        }
    }
}

/// A failed first write: the operation becomes its own rollback.
fn rollback(op: &mut Op) {
    match &mut op.kind {
        Kind::Teardown(teardown) => teardown.phase = TearPhase::RollingBack,
        Kind::Create(create) => create.stage = CreateStage::RollingBack,
        Kind::Fork(fork) => fork.stage = ForkStage::RollingBack,
        Kind::RemoveUnheld(unheld) => unheld.rolling_back = true,
        Kind::CreateWorkspace | Kind::Seat(_) | Kind::Relocate(_) | Kind::Restore | Kind::Resume { .. } | Kind::Reconcile(_) => {}
    }
}

fn rolling_back(op: &Op) -> bool {
    match &op.kind {
        Kind::Teardown(teardown) => teardown.phase == TearPhase::RollingBack,
        Kind::Create(create) => create.stage == CreateStage::RollingBack,
        Kind::Fork(fork) => fork.stage == ForkStage::RollingBack,
        Kind::RemoveUnheld(unheld) => unheld.rolling_back,
        Kind::CreateWorkspace | Kind::Seat(_) | Kind::Relocate(_) | Kind::Restore | Kind::Resume { .. } | Kind::Reconcile(_) => false,
    }
}

fn journal_removed(state: &mut State, id: OpId, attempt: u32, result: StepResult, fx: &mut Fx) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    let Some(book) = op.book.as_mut() else { return };
    if book.removing != Some(attempt) {
        return;
    }
    book.removing = None;
    let rolled_back = rolling_back(op);
    match result {
        Ok(()) => {
            if rolled_back {
                answer_op(op, fx, Answer::refused(Refusal::JournalUnavailable));
            }
            state.ops.remove(&id);
        }
        Err(error) => {
            fx.warn(format!("{id}: the journal entry was not removed ({error}); the next launch finishes it"));
            if rolled_back {
                answer_op(op, fx, Answer::refused(Refusal::JournalStuck));
            }
            op.owed = true;
        }
    }
}

/// Let every operation go as far as the state allows, then keep each
/// journal in step with its operation.
fn settle(state: &mut State, fx: &mut Fx) {
    for _ in 0..64 {
        let before = state.clone();
        let ids: Vec<OpId> = state.ops.keys().copied().collect();
        for id in ids {
            advance(state, id, fx);
        }
        let saved = state.saved;
        for (&id, op) in state.ops.iter_mut() {
            sync_journal(id, op, saved);
        }
        if *state == before {
            return;
        }
    }
    fx.warn("the lifecycle machine did not settle in 64 rounds".into());
}

fn advance(state: &mut State, id: OpId, fx: &mut Fx) {
    let Some(op) = state.ops.get(&id) else { return };
    if op.owed || op.book.as_ref().is_some_and(|book| book.removing.is_some()) || rolling_back(op) {
        return;
    }
    match &op.kind {
        Kind::CreateWorkspace => create::advance_workspace(state, id, fx),
        Kind::Create(_) => create::advance_create(state, id, fx),
        Kind::Seat(_) => create::advance_seat(state, id, fx),
        Kind::Fork(_) => create::advance_fork(state, id, fx),
        Kind::Relocate(_) => create::advance_relocate(state, id, fx),
        Kind::Teardown(_) => teardown::advance(state, id, fx),
        Kind::Restore | Kind::Resume { .. } => create::advance_flag(state, id, fx),
        Kind::RemoveUnheld(_) => teardown::advance_unheld(state, id, fx),
        Kind::Reconcile(_) => boot::advance_reconcile(state, id, fx),
    }
}

/// Start the next write when the entry an operation wants differs from what
/// is on disk and no write is on its way.
fn sync_journal(id: OpId, op: &mut Op, saved: Option<Revision>) {
    let wanted = op.entry(id, saved);
    let Some(book) = op.book.as_mut() else { return };
    if book.flying.is_some() || book.removing.is_some() || op.owed {
        return;
    }
    if let Some(entry) = wanted {
        if book.written.as_ref() != Some(&entry) {
            book.attempts += 1;
            book.flying = Some((book.attempts, entry));
        }
    }
}

/// Whether the entry on disk covers what the operation needs before its next
/// step.
pub fn durable(id: OpId, op: &Op, saved: Option<Revision>) -> bool {
    match &op.book {
        None => true,
        Some(book) => book.flying.is_none() && book.written.is_some() && book.written == op.entry(id, saved),
    }
}

/// Finish an operation: take its entry off disk, or drop it at once.
pub fn finish(state: &mut State, id: OpId) {
    let Some(op) = state.ops.get_mut(&id) else { return };
    match op.book.as_mut() {
        Some(book) if book.written.is_some() || book.flying.is_some() => {
            if book.flying.is_none() && book.removing.is_none() {
                book.attempts += 1;
                book.removing = Some(book.attempts);
            }
        }
        _ => {
            state.ops.remove(&id);
        }
    }
}

pub fn work(state: &State) -> Owed<Effect, Event> {
    let mut owed = Owed::nothing();
    for (&id, op) in &state.ops {
        if let Some(book) = &op.book {
            if let Some((attempt, entry)) = &book.flying {
                owed = owed.run(Effect::WriteJournal { op: id, attempt: *attempt, entry: Box::new(entry.clone()) });
            }
            if let Some(attempt) = book.removing {
                owed = owed.run(Effect::RemoveJournal { op: id, attempt });
            }
        }
        if op.owed || rolling_back(op) {
            continue;
        }
        owed = match &op.kind {
            Kind::Create(create) => create::work(state, id, op, create, owed),
            Kind::Fork(fork) => create::work_fork(state, id, op, fork, owed),
            Kind::Teardown(teardown) => teardown::work(state, id, op, teardown, owed),
            Kind::RemoveUnheld(unheld) => teardown::work_unheld(state, id, op, unheld, owed),
            Kind::Reconcile(reconcile) => boot::work(id, reconcile, owed),
            Kind::CreateWorkspace | Kind::Seat(_) | Kind::Relocate(_) | Kind::Restore | Kind::Resume { .. } => owed,
        };
    }
    launch::work(state, owed)
}

#[cfg(test)]
mod tests;
