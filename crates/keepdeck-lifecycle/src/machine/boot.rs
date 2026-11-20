//! Boot: the barrier, the handshake, the operations the journal left, and
//! the reconciliation that does what the deck's watcher used to do after a
//! load.

use super::create::{Create, CreateStage, Fork, ForkStage};
use super::teardown::{TearPhase, Teardown, Unheld};
use super::{Book, Clean, Effect, Event, Forgotten, Fx, Kind, Op, Sent, State};
use crate::command::{Cmd, Outcome};
use crate::ids::{AskId, Counter, OpId, PaneId, TeamId};
use crate::journal::{Entry, Step, Target, Ticket, Work};
use crate::model::{self, Answer, Draft, Refusal, Site};
use crate::world::{DeckFacts, TeamAt, TeamAtFacts, World};
use keepdeck_fsm::Owed;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// How the deck loaded, as TS says at the handshake.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Load {
    /// Loaded, or there was none: normal running and reconciliation.
    Loaded,
    /// It was damaged and put aside, and work began on an empty deck: work
    /// goes on, but nothing is removed — by an operation or by absence —
    /// until a deck loads normally.
    Quarantined,
    /// Written by a newer build: KeepDeck only shows.
    Newer,
    /// Reading it failed for now: only shows.
    ReadFailed,
    /// Putting a damaged deck aside failed: only shows.
    QuarantineFailed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Boot {
    /// Another KeepDeck holds the journal root: this one only shows.
    ViewOnly,
    /// Started; the deck has not loaded yet.
    Waiting { journal: Vec<Entry> },
    Ready { load: Load },
}

impl Boot {
    /// The barrier is down.
    pub fn open(&self) -> bool {
        matches!(self, Boot::Ready { load: Load::Loaded | Load::Quarantined })
    }

    /// Removals and reconciliation may run.
    pub fn cleans(&self) -> bool {
        matches!(self, Boot::Ready { load: Load::Loaded })
    }
}

/// Boot's reconciliation: the stores' data of workspaces that are neither on
/// the deck nor in the journal, the tasks of absent teams, the mail of absent
/// panes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reconcile {
    pub workspaces: Vec<crate::ids::WorkspaceId>,
    pub done: bool,
}

pub fn handshake(state: &mut State, ask: AskId, deck: DeckFacts, load: Load, fx: &mut Fx) {
    let journal = match &state.boot {
        Boot::Waiting { journal } => journal.clone(),
        Boot::ViewOnly => return fx.answer(ask, Answer::refused(Refusal::BarrierUp)),
        Boot::Ready { .. } => return fx.answer(ask, Answer::refused(Refusal::Busy)),
    };
    state.world = World::from_facts(&deck);
    state.boot = Boot::Ready { load };
    if !matches!(load, Load::Loaded | Load::Quarantined) {
        return fx.answer(ask, Answer::Booted { finishing: Vec::new() });
    }
    let journal_panes = journal.iter().flat_map(entry_panes);
    state.next.pane = Counter::above(state.world.panes.keys().map(|pane| pane.0).chain(journal_panes.map(|pane| pane.0)));
    let closing: BTreeSet<TeamId> = journal.iter().flat_map(closed_teams).collect();
    let closing_workspaces: BTreeSet<_> = journal
        .iter()
        .filter(|entry| matches!(entry.work, Work::Close { target: Target::Workspace, .. }))
        .map(|entry| entry.workspace.clone())
        .collect();
    let mut finishing = Vec::new();
    for entry in &journal {
        if let Some(op) = restore(state, entry, &journal, &closing, &closing_workspaces) {
            state.ops.insert(entry.op, op);
            finishing.push(entry.op);
        }
    }
    // A creation the deck saved as going on, with no entry behind it, is a
    // failed one with Retry — as today.
    for ws in &deck.workspaces {
        for team in &ws.teams {
            let TeamAtFacts::Provisioning { path, branch } = &team.at else { continue };
            let row = state.world.teams.get_mut(&team.id).expect("from the facts");
            if matches!(row.at, TeamAt::Creating { .. }) {
                continue;
            }
            let branch = branch.clone().unwrap_or_else(|| path.as_str().rsplit('/').next().unwrap_or_default().to_owned());
            row.at = TeamAt::Failed { ticket: Ticket { repo: ws.cwd.clone(), path: path.clone(), branch, base: None } };
        }
        // An archive the deck says was under way, with no entry: finished.
        if ws.archiving && !journal.iter().any(|entry| entry.workspace == ws.id && matches!(entry.work, Work::Archive { .. })) {
            let id = state.mint_op();
            let mut teardown = Teardown::new(model::Teardown::Archive, Target::Workspace, Vec::new(), Vec::new(), model::Consent::default());
            teardown.capture(&state.world, &ws.id);
            teardown.restored = true;
            teardown.phase = TearPhase::Journaling;
            let op = Op { workspace: ws.id.clone(), ask: None, book: Some(Book::default()), sent: Vec::new(), kind: Kind::Teardown(Box::new(teardown)), owed: false };
            state.ops.insert(id, op);
            finishing.push(id);
        }
    }
    if load == Load::Loaded {
        let mut live: Vec<_> = state.world.workspaces.keys().cloned().collect();
        live.extend(journal.iter().map(|entry| entry.workspace.clone()));
        live.sort();
        live.dedup();
        let id = state.mint_op();
        let mut op = Op {
            workspace: crate::ids::WorkspaceId(String::new()),
            ask: None,
            book: None,
            sent: Vec::new(),
            kind: Kind::Reconcile(Reconcile { workspaces: live, done: false }),
            owed: false,
        };
        op.send(Cmd::RetainTeams { teams: state.world.teams.keys().cloned().collect() });
        op.send(Cmd::RetainPanes { panes: state.world.panes.keys().copied().collect() });
        state.ops.insert(id, op);
    }
    fx.answer(ask, Answer::Booted { finishing });
}

fn entry_panes(entry: &Entry) -> Vec<PaneId> {
    let mut panes = match &entry.work {
        Work::Close { panes, .. } | Work::Archive { panes } => panes.clone(),
        Work::Fork { pane, .. } => vec![*pane],
        Work::Create { .. } | Work::RemoveUnheld { .. } => Vec::new(),
    };
    for sent in &entry.commands {
        match &sent.command.cmd {
            Cmd::AddPane { pane, .. } | Cmd::RemovePane { pane, .. } | Cmd::MovePane { pane, .. } => panes.push(*pane),
            Cmd::AddTeam { members, .. } => panes.extend(members.iter().map(|member| member.pane)),
            _ => {}
        }
    }
    panes
}

/// What a close's entry forgets: what it ends — its membership final in the
/// entry, no deck needed. Part of the machine's state from its start, so the
/// commit check refuses a write for it before the deck has loaded and any
/// door has opened.
pub(super) fn forget_closed(forgotten: &mut Forgotten, entry: &Entry) {
    let Work::Close { target, teams, panes, .. } = &entry.work else { return };
    match target {
        Target::Workspace => {
            forgotten.workspaces.insert(entry.workspace.clone());
            forgotten.teams.extend(teams.iter().cloned());
        }
        Target::Team { .. } => forgotten.teams.extend(teams.iter().cloned()),
        Target::Agent { .. } => {}
    }
    forgotten.panes.extend(panes.iter().copied());
}

/// The close in the journal that took the creation `creation` over by the
/// person's consent to its ticket, while its entry does not hold the
/// ticket's checkout.
fn taken_over(journal: &[Entry], creation: OpId, ticket: &Ticket) -> Option<OpId> {
    journal.iter().find_map(|close| match &close.work {
        Work::Close { consent, .. } if consent.tickets.contains(&creation) && !consent.folders.iter().any(|folder| folder.path == ticket.path) => Some(close.op),
        _ => None,
    })
}

fn closed_teams(entry: &Entry) -> Vec<TeamId> {
    match &entry.work {
        Work::Close { teams, .. } => teams.clone(),
        _ => Vec::new(),
    }
}

/// An operation from its entry. Its restored phase asks for its work again;
/// its commands not settled are asked again under the same ids.
fn restore(state: &mut State, entry: &Entry, journal: &[Entry], closing: &BTreeSet<TeamId>, closing_workspaces: &BTreeSet<crate::ids::WorkspaceId>) -> Option<Op> {
    let sent = entry
        .commands
        .iter()
        .map(|sent| {
            let outcome = match (&sent.rejected, sent.settled) {
                (Some(why), _) => Some(Outcome::Rejected { why: why.clone() }),
                (None, true) => Some(Outcome::Unchanged { revision: None }),
                (None, false) => None,
            };
            Sent { cmd: sent.command.cmd.clone(), outcome }
        })
        .collect();
    let book = Some(Book { written: Some(entry.clone()), ..Book::default() });
    let kind = match &entry.work {
        Work::Close { target, teams, panes, consent, removals, space } => {
            let kind = match target {
                Target::Agent { .. } => model::Teardown::CloseAgent,
                Target::Team { .. } => model::Teardown::Disband,
                Target::Workspace => model::Teardown::CloseWorkspace,
            };
            let mut teardown = Teardown::new(kind, target.clone(), teams.clone(), panes.clone(), consent.clone());
            teardown.removals = removals.clone();
            teardown.space = space.clone();
            teardown.joined = entry.joined.clone();
            teardown.done = entry.done.clone();
            teardown.restored = true;
            teardown.phase = TearPhase::Retiring;
            teardown.waited.retire = true;
            Kind::Teardown(Box::new(teardown))
        }
        Work::Archive { panes } => {
            let mut teardown = Teardown::new(model::Teardown::Archive, Target::Workspace, state.world.teams_of(&entry.workspace), panes.clone(), model::Consent::default());
            teardown.done = entry.done.clone();
            teardown.restored = true;
            teardown.phase = TearPhase::Retiring;
            teardown.waited.retire = true;
            Kind::Teardown(Box::new(teardown))
        }
        Work::Create { team, ticket } => {
            let mut create = Create::new(team.clone(), Draft(serde_json::Value::Null), Site::New { place: None, base: ticket.base.clone() }, Vec::new(), None, false);
            create.ticket = Some(ticket.clone());
            let covered = closing.contains(team) || closing_workspaces.contains(&entry.workspace);
            let on_deck = state.world.teams.contains_key(team);
            if covered {
                create.abandoned = true;
                create.stage = CreateStage::Creating;
                match taken_over(journal, entry.op, ticket) {
                    // The person agreed to delete what this ticket made, and
                    // the close's entry does not hold the checkout yet — the
                    // launch died between git's answer and that write. Git
                    // is asked whether the checkout stands, and only then is
                    // it handed over; until the close's entry holds it, this
                    // entry stays its trace.
                    Some(close) => {
                        create.taken_by = Some(close);
                        create.find_only = true;
                    }
                    // Handed over already, or not agreed to: nothing is left
                    // for the creation to do.
                    None => create.created = true,
                }
            } else if on_deck {
                // `git worktree add` may have finished unrecorded: the
                // checkout at the ticket is this ticket's, and is picked up.
                create.retry = true;
                create.stage = CreateStage::Creating;
                if let Some(row) = state.world.teams.get_mut(team) {
                    row.at = TeamAt::Creating { op: entry.op, ticket: ticket.clone() };
                }
            } else {
                create.stage = CreateStage::Undoing;
            }
            Kind::Create(Box::new(create))
        }
        Work::Fork { pane, source, team, ticket, discard } => {
            let made = team.as_ref().map(|team| {
                let mut create = Create::new(team.clone(), Draft(serde_json::Value::Null), Site::Root, Vec::new(), None, true);
                create.ticket = ticket.clone();
                create.created = true;
                create.stage = CreateStage::Creating;
                create
            });
            let landing = team.clone().or_else(|| state.world.panes.get(pane).and_then(|row| row.team.clone()));
            let mut fork = Fork::new(landing.unwrap_or_else(|| TeamId(String::new())), *pane, Draft(serde_json::Value::Null), source.clone(), made);
            fork.discard = discard.clone();
            fork.done = entry.done.clone();
            // An open fork at boot did not finish; its hook died with the
            // launch that called it — or lives on, unseen, and is deleted
            // regardless.
            fork.stage = ForkStage::Undoing;
            fork.hook_ended = true;
            fork.added = state.world.panes.contains_key(pane);
            Kind::Fork(Box::new(fork))
        }
        Work::RemoveUnheld { path, tag, repo } => {
            // An entry written before the repository was kept takes it from
            // its workspace, while that stands.
            let repo = repo.clone().or_else(|| state.world.workspaces.get(&entry.workspace).map(|ws| ws.cwd.clone()));
            let mut unheld = Unheld::new(path.clone(), tag.clone(), repo);
            unheld.done = entry.done.clone();
            unheld.answered = true;
            Kind::RemoveUnheld(unheld)
        }
    };
    Some(Op { workspace: entry.workspace.clone(), ask: None, book, sent, kind, owed: false })
}

pub fn advance_reconcile(state: &mut State, id: OpId, _fx: &mut Fx) {
    let op = &state.ops[&id];
    let Kind::Reconcile(reconcile) = &op.kind else { return };
    if reconcile.done && op.all_settled(state.saved) {
        super::finish(state, id);
    }
}

pub fn reconcile_done(reconcile: &mut Reconcile) {
    reconcile.done = true;
}

pub fn work(id: OpId, reconcile: &Reconcile, owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    if reconcile.done {
        return owed;
    }
    owed.run(Effect::Clean {
        op: id,
        workspace: crate::ids::WorkspaceId(String::new()),
        step: Step::Stores,
        how: Clean::Retain { workspaces: reconcile.workspaces.clone() },
    })
}
