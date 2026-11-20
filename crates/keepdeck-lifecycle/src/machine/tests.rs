//! The machine's rules, on plain `update` and `work` — no runtime. A `Sim`
//! plays the world: it hands the machine the events its effects and owners
//! would send, one step at a time or all of them until nothing is owed.

use super::snapshot::{snapshot, TeamPhase};
use super::*;
use crate::command::{Cmd, Command, Outcome, Revision};
use crate::journal::{Discard, Entry, Step, Target, Work};
use crate::model::{self, Answer, Consent, Continuation, Draft, Folder, Intent, Landing, Place, Refusal, SessionKey, Site};
use crate::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};
use keepdeck_fsm::Work as Owe;
use serde_json::json;
use std::collections::BTreeMap;

fn ws() -> WorkspaceId {
    WorkspaceId("ws-a".into())
}

fn team(name: &str) -> TeamId {
    TeamId(format!("team-{name}"))
}

fn draft() -> Draft {
    Draft(json!({ "agentType": "claude" }))
}

fn pane_facts(n: u64, team_name: Option<&str>) -> PaneFacts {
    PaneFacts { id: PaneId(n), team: team_name.map(team), remote: false, suspended: false }
}

/// One workspace "app" on /repo, worktrees in /wt: team-1 in its own worktree
/// with panes 1 and 2, team-r in the root with pane 3.
fn deck() -> DeckFacts {
    DeckFacts {
        workspaces: vec![WorkspaceFacts {
            id: ws(),
            name: "app".into(),
            cwd: Dir::new("/repo"),
            worktree_base: Some(Dir::new("/wt")),
            archived: false,
            archiving: false,
            teams: vec![
                TeamFacts { id: team("1"), at: TeamAtFacts::Attached { cwd: Dir::new("/wt/kd-app-1"), branch: Some("kd/app/1".into()) } },
                TeamFacts { id: team("r"), at: TeamAtFacts::Attached { cwd: Dir::new("/repo"), branch: None } },
            ],
            panes: vec![pane_facts(1, Some("1")), pane_facts(2, Some("1")), pane_facts(3, Some("r"))],
        }],
    }
}

fn consent_for_team_1() -> Consent {
    Consent {
        folders: vec![Folder { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-1"), branch: Some("kd/app/1".into()), present: true }],
        tickets: vec![],
    }
}

struct Sim {
    state: State,
    log: Vec<Effect>,
    asks: u64,
    revision: u64,
    sessions: u64,
    /// The journal on disk.
    disk: BTreeMap<OpId, Entry>,
    /// Every cleanup step the world carried out, and every command an owner did.
    cleaned: Vec<Clean>,
    carried: Vec<Cmd>,
}

impl Sim {
    fn new(journal: Option<Vec<Entry>>) -> Sim {
        let disk = journal.iter().flatten().map(|entry| (entry.op, entry.clone())).collect();
        Sim { state: State::start(journal), log: Vec::new(), asks: 0, revision: 0, sessions: 0, disk, cleaned: Vec::new(), carried: Vec::new() }
    }

    fn booted_with(deck: DeckFacts, journal: Vec<Entry>) -> Sim {
        let mut sim = Sim::new(Some(journal));
        let ask = sim.next_ask();
        sim.send(Event::Handshake { ask, deck, load: Load::Loaded });
        sim
    }

    fn booted() -> Sim {
        let mut sim = Sim::booted_with(deck(), Vec::new());
        sim.drive();
        sim.log.clear();
        sim
    }

    fn next_ask(&mut self) -> AskId {
        self.asks += 1;
        AskId(self.asks)
    }

    fn send(&mut self, event: Event) {
        let next = update(&self.state, event);
        if let Some(state) = next.state {
            self.state = state;
        }
        self.log.extend(next.effects);
    }

    fn intent(&mut self, intent: Intent) -> AskId {
        let ask = self.next_ask();
        self.send(Event::Intent { ask, intent });
        ask
    }

    /// The answer an ask got — and it got exactly one, if any.
    fn answer(&self, ask: AskId) -> Option<Answer> {
        let answers: Vec<&Answer> = self
            .log
            .iter()
            .filter_map(|effect| match effect {
                Effect::Answer { ask: to, answer } if *to == ask => Some(answer),
                _ => None,
            })
            .collect();
        assert!(answers.len() <= 1, "{ask:?} answered {} times: {answers:?}", answers.len());
        answers.first().map(|answer| (*answer).clone())
    }

    fn refusal(&self, ask: AskId) -> Option<Refusal> {
        match self.answer(ask) {
            Some(Answer::Refused { refusal }) => Some(refusal),
            _ => None,
        }
    }

    fn accepted_op(&self, ask: AskId) -> OpId {
        match self.answer(ask) {
            Some(Answer::Accepted { op, .. }) => op,
            other => panic!("{ask:?} not accepted: {other:?}"),
        }
    }

    fn owed(&self) -> Vec<Effect> {
        work(&self.state)
            .into_iter()
            .filter_map(|work| match work {
                Owe::Run(effect) => Some(effect),
                Owe::After(..) => None,
            })
            .collect()
    }

    fn timers(&self) -> Vec<Event> {
        work(&self.state)
            .into_iter()
            .filter_map(|work| match work {
                Owe::After(_, event) => Some(event),
                Owe::Run(_) => None,
            })
            .collect()
    }

    fn pending(&self) -> Vec<Command> {
        snapshot(&self.state).commands
    }

    fn pending_matching(&self, pred: impl Fn(&Cmd) -> bool) -> Vec<Command> {
        self.pending().into_iter().filter(|command| pred(&command.cmd)).collect()
    }

    /// Every journal write and removal owed lands.
    fn write_journals(&mut self) {
        for effect in self.owed() {
            match effect {
                Effect::WriteJournal { op, attempt, entry } => {
                    self.disk.insert(op, *entry);
                    self.send(Event::JournalWritten { op, attempt, result: Ok(()) });
                }
                Effect::RemoveJournal { op, attempt } => {
                    self.disk.remove(&op);
                    self.send(Event::JournalRemoved { op, attempt, result: Ok(()) });
                }
                _ => {}
            }
        }
    }

    /// Journal writes land until none is owed: one at a time, as on disk.
    fn flush_journals(&mut self) {
        for _ in 0..10 {
            if !self.owed().iter().any(|effect| matches!(effect, Effect::WriteJournal { .. } | Effect::RemoveJournal { .. })) {
                return;
            }
            self.write_journals();
        }
    }

    fn outcome_for(&mut self, cmd: &Cmd) -> Outcome {
        match cmd {
            Cmd::Fork { .. } => Outcome::Forked { discard: Discard { plugin: "claude".into(), once_started: vec!["/c/scratch".into()], if_never_started: vec!["/c/copy".into()] } },
            cmd if cmd.owner() == crate::command::Owner::Deck => {
                self.revision += 1;
                Outcome::Applied { revision: Some(Revision(self.revision)) }
            }
            _ => Outcome::Applied { revision: None },
        }
    }

    /// Owners answer every pending command matching `pred`, «applied».
    fn apply(&mut self, pred: impl Fn(&Cmd) -> bool) {
        for command in self.pending_matching(pred) {
            let answered = self.state.ops.get(&command.id.op).and_then(|op| op.sent.get(command.id.index as usize)).is_some_and(|sent| sent.outcome.is_some());
            if answered {
                continue;
            }
            self.carried.push(command.cmd.clone());
            let outcome = self.outcome_for(&command.cmd);
            self.send(Event::Answered { id: command.id, outcome });
        }
    }

    fn reply(&mut self, pred: impl Fn(&Cmd) -> bool, outcome: Outcome) {
        for command in self.pending_matching(pred) {
            self.send(Event::Answered { id: command.id, outcome: outcome.clone() });
        }
    }

    fn save(&mut self) {
        let revision = Revision(self.revision);
        self.send(Event::DeckSaved { revision });
    }

    fn appear(&mut self, owner: LaunchOwner, attempt: Option<AttemptId>, dir: Option<&str>) -> SessionId {
        self.sessions += 1;
        let session = SessionId(self.sessions);
        self.send(Event::SessionAppeared { session, attempt, owner, dir: dir.map(Dir::new) });
        session
    }

    /// One round of a world that does what it is asked.
    fn round(&mut self) -> bool {
        let before = self.state.clone();
        self.write_journals();
        for effect in self.owed() {
            let event = match effect {
                Effect::Probe { op, path, .. } => Event::Probed { op, path, taken: false },
                Effect::CreateWorktree { op, .. } => Event::Created { op, result: Ok(()) },
                Effect::ReadBranches { op, path, .. } => Event::BranchesRead { op, path, result: Ok(Vec::new()) },
                Effect::Clean { op, step, how, .. } => {
                    if !self.cleaned.contains(&how) {
                        self.cleaned.push(how);
                    }
                    Event::StepDone { op, step, result: Ok(()) }
                }
                Effect::Stop { session, .. } => Event::SessionEnded { session },
                Effect::Cancel { op, .. } => Event::Cancelled { op, started: Vec::new() },
                _ => continue,
            };
            self.send(event);
        }
        self.apply(|_| true);
        self.save();
        // The fork step's hook has ended once its result is in.
        let forks: Vec<OpId> = self.state.ops.iter().filter(|(_, op)| matches!(&op.kind, Kind::Fork(fork) if fork.hook_sent && !fork.hook_ended)).map(|(&id, _)| id).collect();
        for op in forks {
            self.send(Event::HookEnded { op });
        }
        self.state != before
    }

    fn drive(&mut self) {
        for _ in 0..100 {
            if !self.round() {
                return;
            }
        }
        panic!("the machine did not settle: {:#?}", self.state.ops);
    }
}

fn close_agent(pane: u64) -> Intent {
    Intent::CloseAgent { workspace: ws(), pane: PaneId(pane), consent: Consent::default() }
}

fn disband(name: &str, consent: Consent) -> Intent {
    Intent::Disband { workspace: ws(), team: team(name), consent }
}

fn seat(name: &str) -> Intent {
    Intent::Seat { workspace: ws(), team: team(name), member: draft() }
}

// ---------------------------------------------------------------- the barrier

#[test]
fn nothing_goes_before_the_handshake_and_a_view_only_copy_never_opens() {
    let mut sim = Sim::new(Some(Vec::new()));
    let ask = sim.intent(close_agent(1));
    assert_eq!(sim.refusal(ask), Some(Refusal::BarrierUp));
    let lease = sim.next_ask();
    sim.send(Event::Lease { ask: lease, lease: LeaseAsk::Launch { workspace: ws(), owner: LaunchOwner::Pane { pane: PaneId(1) }, dir: None } });
    assert_eq!(sim.refusal(lease), Some(Refusal::BarrierUp));

    let mut view = Sim::new(None);
    let ask = view.next_ask();
    view.send(Event::Handshake { ask, deck: deck(), load: Load::Loaded });
    assert_eq!(view.refusal(ask), Some(Refusal::BarrierUp), "without the journal root, only shows");
    assert!(!view.state.open());
}

#[test]
fn a_deck_that_did_not_load_keeps_the_barrier_up_and_a_quarantined_one_removes_nothing() {
    for load in [Load::Newer, Load::ReadFailed, Load::QuarantineFailed] {
        let mut sim = Sim::new(Some(Vec::new()));
        let ask = sim.next_ask();
        sim.send(Event::Handshake { ask, deck: deck(), load });
        assert!(!sim.state.open(), "{load:?}");
        assert!(snapshot(&sim.state).view_only);
    }
    let mut sim = Sim::new(Some(Vec::new()));
    let ask = sim.next_ask();
    sim.send(Event::Handshake { ask, deck: deck(), load: Load::Quarantined });
    assert!(sim.state.open(), "work goes on");
    assert!(!sim.state.boot.cleans(), "but nothing is removed");
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::RetainTeams { .. })).is_empty(), "no reconciliation by absence");
}

// ---------------------------------------------------------------- a close, end to end

#[test]
fn a_close_answers_only_once_its_entry_is_on_disk_then_forgets_and_retires_before_it_stops() {
    let mut sim = Sim::booted();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(2) }, None, Some("/wt/kd-app-1"));
    let ask = sim.intent(close_agent(2));
    assert_eq!(sim.answer(ask), None, "not before the entry is on disk");
    assert!(!sim.state.forgotten.panes.contains(&PaneId(2)));
    sim.write_journals();
    let op = sim.accepted_op(ask);
    assert!(sim.disk.contains_key(&op));
    assert!(sim.state.forgotten.panes.contains(&PaneId(2)), "forgotten once accepted");
    // «Retire» goes first; no stop and no deck command until it is answered.
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::Retire { .. })).len(), 1);
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::RemovePane { .. })).is_empty());
    assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::Stop { .. })));
    sim.apply(|cmd| matches!(cmd, Cmd::Retire { .. }));
    assert!(sim.owed().contains(&Effect::Stop { session }));
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::RemovePane { .. })).len(), 1);
    sim.drive();
    assert!(sim.state.ops.is_empty(), "done: {:?}", sim.state.ops);
    assert!(sim.disk.is_empty(), "the entry is removed at the end");
    assert!(!sim.state.world.panes.contains_key(&PaneId(2)));
    assert!(sim.log.iter().any(|effect| matches!(effect, Effect::Answer { .. })));
}

#[test]
fn retire_that_is_never_answered_holds_a_close_only_until_its_timer() {
    let mut sim = Sim::booted();
    sim.intent(close_agent(2));
    sim.write_journals();
    let op = *sim.state.ops.keys().next().unwrap();
    assert!(sim.timers().contains(&Event::Timer(Timer::Retire { op })));
    sim.send(Event::Timer(Timer::Retire { op }));
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::RemovePane { .. })).len(), 1, "the close went on");
}

#[test]
fn a_disband_deletes_its_folder_by_consent_and_forgets_its_tasks_and_mail() {
    let mut sim = Sim::booted();
    let ask = sim.intent(disband("1", consent_for_team_1()));
    sim.drive();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    let (repo, path) = (Dir::new("/repo"), Dir::new("/wt/kd-app-1"));
    assert!(sim.cleaned.contains(&Clean::Disarm { dir: path.clone() }));
    assert!(sim.cleaned.contains(&Clean::Checkout { repo: repo.clone(), path }));
    assert!(sim.cleaned.contains(&Clean::Branch { repo, name: "kd/app/1".into(), confirmed_absent: false }));
    assert!(!sim.cleaned.contains(&Clean::Stores), "a team's close leaves the workspace's stores alone");
    assert!(sim.carried.contains(&Cmd::DeleteTeamTasks { workspace: ws(), team: team("1") }));
    assert!(sim.carried.contains(&Cmd::ForgetPaneMail { workspace: ws(), pane: PaneId(1) }));
    assert!(sim.carried.contains(&Cmd::ForgetPaneMail { workspace: ws(), pane: PaneId(2) }));
    assert!(!sim.state.world.teams.contains_key(&team("1")));
    assert!(!sim.state.world.panes.contains_key(&PaneId(1)) && !sim.state.world.panes.contains_key(&PaneId(2)));
    assert!(sim.state.world.panes.contains_key(&PaneId(3)), "the other team stays");
    assert!(sim.state.forgotten.teams.contains(&team("1")));
}

#[test]
fn a_close_plans_each_folder_before_its_first_step_and_removes_the_checkout_before_its_branches() {
    let mut sim = Sim::booted();
    sim.intent(disband("1", consent_for_team_1()));
    for _ in 0..4 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
        for effect in sim.owed() {
            if let Effect::Stop { session, .. } = effect {
                sim.send(Event::SessionEnded { session });
            }
        }
    }
    let op = *sim.state.ops.keys().next().unwrap();
    let reads: Vec<Effect> = sim.owed().into_iter().filter(|effect| matches!(effect, Effect::ReadBranches { .. })).collect();
    assert_eq!(reads.len(), 1, "the plan is read first: {:?}", sim.owed());
    sim.send(Event::BranchesRead { op, path: Dir::new("/wt/kd-app-1"), result: Ok(vec!["feature".into()]) });
    assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. }, .. })), "not before the plan is on disk");
    sim.write_journals();
    let Some(Entry { work: Work::Close { removals, .. }, .. }) = sim.disk.get(&op) else { panic!("an entry") };
    assert_eq!(removals[0].branches, ["feature", "kd/app/1"]);
    // Plantings first, then the checkout, then its branches.
    let owed = sim.owed();
    assert!(owed.iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Disarm { .. }, .. })));
    assert!(!owed.iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. } | Clean::Branch { .. }, .. })));
    for effect in owed {
        if let Effect::Clean { op, step, how: Clean::Disarm { .. }, .. } = effect {
            sim.send(Event::StepDone { op, step, result: Ok(()) });
        }
    }
    let owed = sim.owed();
    assert!(owed.iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. }, .. })));
    assert!(!owed.iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Branch { .. }, .. })), "branches wait for the checkout");
}

#[test]
fn a_failed_cleanup_step_keeps_the_entry_and_the_place_and_says_the_worktree_was_not_deleted() {
    let mut sim = Sim::booted();
    sim.intent(disband("1", consent_for_team_1()));
    for _ in 0..30 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
        for effect in sim.owed() {
            let event = match effect {
                Effect::ReadBranches { op, path, .. } => Event::BranchesRead { op, path, result: Ok(Vec::new()) },
                Effect::Clean { op, step, how: Clean::Checkout { .. }, .. } => Event::StepDone { op, step, result: Err("busy".into()) },
                Effect::Clean { op, step, .. } => Event::StepDone { op, step, result: Ok(()) },
                Effect::Stop { session, .. } => Event::SessionEnded { session },
                _ => continue,
            };
            sim.send(event);
        }
    }
    let (op, entry) = sim.disk.iter().next().expect("the entry stays");
    assert!(sim.state.ops[op].owed, "a debt for the next launch");
    assert!(!entry.done.iter().any(|step| matches!(step, Step::Checkout { .. })));
    assert!(sim.log.iter().any(|effect| matches!(effect, Effect::Warn { .. })));
    let notice = sim.state.ops[op].sent.iter().any(|sent| matches!(sent.cmd, Cmd::WorktreeNotDeleted { .. }));
    assert!(notice, "«worktree not deleted», as today");
    // The place stays held: a new team does not get number 1.
    let create = sim.intent(Intent::CreateTeam { workspace: ws(), team: team("new"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
    let probe = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Probe { path, .. } => Some(path),
        _ => None,
    });
    assert_eq!(probe, Some(Dir::new("/wt/kd-app-2")), "{:?}", sim.answer(create));
}

// ---------------------------------------------------------------- the journal and the one answer

#[test]
fn a_failed_first_write_takes_the_entry_back_and_answers_journal_unavailable() {
    let mut sim = Sim::booted();
    let ask = sim.intent(close_agent(2));
    let Some(Effect::WriteJournal { op, attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::WriteJournal { .. })) else { panic!() };
    sim.send(Event::JournalWritten { op, attempt, result: Err("disk full".into()) });
    assert_eq!(sim.answer(ask), None, "not before the rollback has ended");
    let Some(Effect::RemoveJournal { attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::RemoveJournal { .. })) else { panic!("a rollback") };
    sim.send(Event::JournalRemoved { op, attempt, result: Ok(()) });
    assert_eq!(sim.refusal(ask), Some(Refusal::JournalUnavailable));
    assert!(sim.state.ops.is_empty(), "the capture is let go");
    assert!(!sim.state.forgotten.panes.contains(&PaneId(2)));
    let again = sim.intent(close_agent(2));
    assert_eq!(sim.refusal(again), None, "the pane can be closed again");
}

#[test]
fn a_failed_rollback_answers_journal_stuck_and_keeps_the_capture() {
    let mut sim = Sim::booted();
    let ask = sim.intent(close_agent(2));
    let Some(Effect::WriteJournal { op, attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::WriteJournal { .. })) else { panic!() };
    sim.send(Event::JournalWritten { op, attempt, result: Err("disk full".into()) });
    let Some(Effect::RemoveJournal { attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::RemoveJournal { .. })) else { panic!() };
    sim.send(Event::JournalRemoved { op, attempt, result: Err("read-only".into()) });
    assert_eq!(sim.refusal(ask), Some(Refusal::JournalStuck));
    let again = sim.intent(close_agent(2));
    assert_eq!(sim.refusal(again), Some(Refusal::AlreadyClosing), "the next launch finishes it");
}

#[test]
fn a_late_result_of_an_old_write_changes_nothing() {
    let mut sim = Sim::booted();
    let ask = sim.intent(close_agent(2));
    let Some(Effect::WriteJournal { op, attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::WriteJournal { .. })) else { panic!() };
    sim.send(Event::JournalWritten { op, attempt: attempt + 7, result: Ok(()) });
    assert_eq!(sim.answer(ask), None, "another attempt's result is not this one's");
    sim.send(Event::JournalWritten { op, attempt, result: Ok(()) });
    sim.send(Event::JournalWritten { op, attempt, result: Err("late".into()) });
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })), "answered once, and only once");
}

// ---------------------------------------------------------------- who goes first

#[test]
fn the_first_capture_leads_and_the_next_hears_already_closing_or_busy() {
    let mut sim = Sim::booted();
    sim.intent(disband("1", Consent::default()));
    let member = sim.intent(close_agent(1));
    assert_eq!(sim.refusal(member), Some(Refusal::AlreadyClosing));
    let twice = sim.intent(disband("1", Consent::default()));
    assert_eq!(sim.refusal(twice), Some(Refusal::AlreadyClosing));
    let restart = sim.intent(Intent::Restart { workspace: ws(), pane: PaneId(2) });
    assert_eq!(sim.refusal(restart), Some(Refusal::AlreadyClosing));

    let mut sim = Sim::booted();
    sim.intent(Intent::Restart { workspace: ws(), pane: PaneId(3) });
    let suspend = sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(3) });
    assert_eq!(sim.refusal(suspend), Some(Refusal::Busy));
}

#[test]
fn a_workspace_close_joins_a_disband_under_way_and_leaves_its_consent_alone() {
    let mut sim = Sim::booted();
    sim.intent(disband("1", consent_for_team_1()));
    sim.write_journals();
    let close = sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    assert_eq!(sim.refusal(close), None, "joined, not refused");
    let ops: Vec<&Op> = sim.state.ops.values().collect();
    let joined = ops.iter().find_map(|op| op.teardown().filter(|t| t.kind == model::Teardown::CloseWorkspace).map(|t| t.joined.clone())).unwrap();
    assert_eq!(joined.len(), 1);
    let disband = ops.iter().find_map(|op| op.teardown().filter(|t| t.kind == model::Teardown::Disband)).unwrap();
    assert_eq!(disband.consent, consent_for_team_1(), "its own consent stays");
    sim.drive();
    assert!(sim.state.world.workspaces.is_empty());
}

#[test]
fn a_close_takes_over_a_creation_and_waits_for_its_git_step() {
    let mut sim = Sim::booted();
    let create = sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
    for _ in 0..3 {
        sim.write_journals();
        for effect in sim.owed() {
            if let Effect::Probe { op, path, .. } = effect {
                sim.send(Event::Probed { op, path, taken: false });
            }
        }
        sim.apply(|_| true);
        sim.save();
    }
    assert!(matches!(sim.answer(create), Some(Answer::Accepted { .. })));
    let create_op = *sim.state.ops.keys().next().unwrap();
    assert!(sim.owed().iter().any(|effect| matches!(effect, Effect::CreateWorktree { .. })));
    let consent = Consent { folders: vec![], tickets: vec![create_op] };
    let close = sim.intent(disband("n", consent));
    assert_eq!(sim.refusal(close), None, "a Close may take over a creation");
    for _ in 0..6 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    let close_op = *sim.state.ops.keys().last().unwrap();
    assert!(matches!(sim.state.ops[&close_op].teardown().unwrap().phase, TearPhase::Stopping), "it waits for git");
    sim.send(Event::Created { op: create_op, result: Ok(()) });
    sim.drive();
    assert!(sim.state.ops.is_empty());
    assert!(!sim.state.world.teams.contains_key(&team("n")));
}

#[test]
fn a_close_takes_over_an_archive() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    sim.write_journals();
    let close = sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    assert_eq!(sim.refusal(close), None);
    sim.drive();
    assert!(sim.state.world.workspaces.is_empty());
    assert!(sim.state.ops.is_empty());
}

// ---------------------------------------------------------------- additive operations

#[test]
fn five_seats_in_a_row_land_on_a_team_still_being_created() {
    let mut sim = Sim::booted();
    let create = sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
    for _ in 0..3 {
        sim.write_journals();
        for effect in sim.owed() {
            if let Effect::Probe { op, path, .. } = effect {
                sim.send(Event::Probed { op, path, taken: false });
            }
        }
        sim.apply(|_| true);
        sim.save();
    }
    assert!(matches!(sim.answer(create), Some(Answer::Accepted { .. })));
    let seats: Vec<AskId> = (0..5).map(|_| sim.intent(seat("n"))).collect();
    sim.drive();
    for ask in seats {
        assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })), "{:?}", sim.answer(ask));
    }
    assert_eq!(sim.state.world.members(&team("n")).len(), 5);
}

#[test]
fn a_seat_on_a_leaving_or_archived_target_is_refused() {
    let mut sim = Sim::booted();
    sim.intent(disband("1", Consent::default()));
    let ask = sim.intent(seat("1"));
    assert_eq!(sim.refusal(ask), Some(Refusal::TargetLeaving));

    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    let ask = sim.intent(seat("r"));
    assert_eq!(sim.refusal(ask), Some(Refusal::Archived));
}

#[test]
fn a_seat_the_role_rule_refuses_hears_the_owners_own_kind() {
    let mut sim = Sim::booted();
    let ask = sim.intent(seat("1"));
    sim.reply(|cmd| matches!(cmd, Cmd::AddPane { .. }), Outcome::Rejected { reason: "taken".into() });
    assert_eq!(sim.refusal(ask), Some(Refusal::Rejected { reason: "taken".into() }));
    assert_eq!(sim.state.world.members(&team("1")).len(), 2, "no pane was added");
    sim.drive();
    assert!(sim.state.ops.is_empty());
}

#[test]
fn a_close_queues_behind_a_seat_begun_before_it_and_takes_the_seated_pane() {
    let mut sim = Sim::booted();
    let seat_ask = sim.intent(seat("1"));
    let close = sim.intent(disband("1", Consent::default()));
    // The close holds the team at once: nothing new lands on it.
    let late = sim.intent(seat("1"));
    assert_eq!(sim.refusal(late), Some(Refusal::TargetLeaving));
    // But it takes no step while the seat is out.
    assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::WriteJournal { .. })), "no entry yet");
    assert!(!sim.state.forgotten.teams.contains(&team("1")));
    // Applied is not enough: the close waits for it on disk.
    sim.apply(|cmd| matches!(cmd, Cmd::AddPane { .. }));
    assert!(matches!(sim.answer(seat_ask), Some(Answer::Accepted { .. })));
    assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::WriteJournal { .. })), "applied, not yet saved");
    sim.save();
    let entry = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::WriteJournal { entry, .. } => Some(entry),
        _ => None,
    });
    let Some(entry) = entry else { panic!("the entry, now: {:?}", sim.owed()) };
    let Work::Close { panes, .. } = &entry.work else { panic!() };
    assert_eq!(panes.len(), 3, "the seated pane is in the final membership: {panes:?}");
    sim.drive();
    assert!(matches!(sim.answer(close), Some(Answer::Accepted { .. })));
}

#[test]
fn a_close_after_a_rejected_seat_keeps_the_old_membership_without_waiting_for_a_save() {
    let mut sim = Sim::booted();
    sim.intent(seat("1"));
    sim.intent(disband("1", Consent::default()));
    sim.reply(|cmd| matches!(cmd, Cmd::AddPane { .. }), Outcome::Rejected { reason: "misfit".into() });
    let entry = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::WriteJournal { entry, .. } => Some(entry),
        _ => None,
    });
    let Some(entry) = entry else { panic!("the entry without a save: {:?}", sim.owed()) };
    let Work::Close { panes, .. } = &entry.work else { panic!() };
    assert_eq!(panes, &vec![PaneId(1), PaneId(2)]);
}

// ---------------------------------------------------------------- commands and their answers

#[test]
fn a_command_leaves_only_on_its_own_answer_and_a_deck_command_only_once_it_is_saved() {
    let mut sim = Sim::booted();
    sim.intent(close_agent(2));
    sim.intent(close_agent(3));
    sim.write_journals();
    let retires = sim.pending_matching(|cmd| matches!(cmd, Cmd::Retire { .. }));
    assert_eq!(retires.len(), 2);
    assert_ne!(retires[0].id, retires[1].id, "two of one kind, two names");
    sim.send(Event::Answered { id: retires[0].id, outcome: Outcome::Applied { revision: None } });
    let left = sim.pending_matching(|cmd| matches!(cmd, Cmd::Retire { .. }));
    assert_eq!(left.iter().map(|command| command.id).collect::<Vec<_>>(), [retires[1].id], "the answer closed its own command only");
    sim.send(Event::Answered { id: retires[1].id, outcome: Outcome::Applied { revision: None } });
    let removes = sim.pending_matching(|cmd| matches!(cmd, Cmd::RemovePane { .. }));
    // Saved before it is answered, then answered at that revision: settled.
    sim.send(Event::DeckSaved { revision: Revision(9) });
    sim.send(Event::Answered { id: removes[0].id, outcome: Outcome::Applied { revision: Some(Revision(8)) } });
    // Answered past the saved revision: stays until a save reaches it.
    sim.send(Event::Answered { id: removes[1].id, outcome: Outcome::Applied { revision: Some(Revision(12)) } });
    let pending: Vec<_> = sim.pending_matching(|cmd| matches!(cmd, Cmd::RemovePane { .. })).iter().map(|command| command.id).collect();
    assert_eq!(pending, [removes[1].id]);
    sim.send(Event::DeckSaved { revision: Revision(13) });
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::RemovePane { .. })).is_empty(), "a later save covers an earlier revision");
}

#[test]
fn an_answer_to_a_command_that_is_gone_changes_nothing() {
    let mut sim = Sim::booted();
    let before = sim.state.clone();
    sim.send(Event::Answered { id: CommandId { op: OpId(99), index: 0 }, outcome: Outcome::Applied { revision: None } });
    assert_eq!(sim.state, before);
}

// ---------------------------------------------------------------- launches

fn lease(sim: &mut Sim, pane: u64, dir: &str) -> Answer {
    let ask = sim.next_ask();
    sim.send(Event::Lease { ask, lease: LeaseAsk::Launch { workspace: ws(), owner: LaunchOwner::Pane { pane: PaneId(pane) }, dir: Some(Dir::new(dir)) } });
    sim.answer(ask).expect("an answer")
}

fn admit(sim: &mut Sim, permit: PermitId, pane: u64, dir: &str) -> Answer {
    let ask = sim.next_ask();
    sim.send(Event::Admit { ask, permit, owner: LaunchOwner::Pane { pane: PaneId(pane) }, dir: Some(Dir::new(dir)) });
    sim.answer(ask).expect("an answer")
}

#[test]
fn one_permit_admits_exactly_one_launch_and_only_for_its_owner_and_target() {
    let mut sim = Sim::booted();
    let Answer::Leased { permit } = lease(&mut sim, 1, "/wt/kd-app-1") else { panic!() };
    assert_eq!(admit(&mut sim, permit, 2, "/wt/kd-app-1"), Answer::refused(Refusal::NotFound), "another owner");
    assert_eq!(admit(&mut sim, permit, 1, "/repo"), Answer::refused(Refusal::NotFound), "another target");
    assert!(matches!(admit(&mut sim, permit, 1, "/wt/kd-app-1"), Answer::Admitted { .. }));
    assert_eq!(admit(&mut sim, permit, 1, "/wt/kd-app-1"), Answer::refused(Refusal::NotFound), "spent");
    assert_eq!(admit(&mut sim, PermitId(77), 1, "/wt/kd-app-1"), Answer::refused(Refusal::NotFound), "forged");
}

#[test]
fn a_permit_revoked_by_its_timer_admits_nothing_but_one_admitted_before_stands() {
    let mut sim = Sim::booted();
    let Answer::Leased { permit } = lease(&mut sim, 1, "/wt/kd-app-1") else { panic!() };
    assert!(sim.timers().contains(&Event::Timer(Timer::Permit { permit })));
    sim.send(Event::Timer(Timer::Permit { permit }));
    assert_eq!(admit(&mut sim, permit, 1, "/wt/kd-app-1"), Answer::refused(Refusal::NotFound));

    let Answer::Leased { permit } = lease(&mut sim, 3, "/repo") else { panic!() };
    assert!(matches!(admit(&mut sim, permit, 3, "/repo"), Answer::Admitted { .. }));
    sim.send(Event::Timer(Timer::Permit { permit }));
    assert_eq!(sim.state.attempts.len(), 1, "an admission before the revocation stands");
}

#[test]
fn a_close_revokes_unspent_permits_and_takes_admitted_launches_to_the_start_boundary() {
    let mut sim = Sim::booted();
    let Answer::Leased { permit: unspent } = lease(&mut sim, 1, "/wt/kd-app-1") else { panic!() };
    let Answer::Leased { permit } = lease(&mut sim, 2, "/wt/kd-app-1") else { panic!() };
    let Answer::Admitted { attempt } = admit(&mut sim, permit, 2, "/wt/kd-app-1") else { panic!() };
    sim.intent(disband("1", Consent::default()));
    assert_eq!(admit(&mut sim, unspent, 1, "/wt/kd-app-1"), Answer::refused(Refusal::TargetLeaving), "the target is taken");
    for _ in 0..3 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    let op = *sim.state.ops.keys().next().unwrap();
    assert!(!sim.state.permits.contains_key(&unspent), "revoked");
    assert!(sim.owed().contains(&Effect::Cancel { op, attempts: vec![attempt] }));
    // The process exists: the close waits for its session, then stops it.
    sim.send(Event::Cancelled { op, started: vec![attempt] });
    assert!(sim.timers().contains(&Event::Timer(Timer::Registration { op })));
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(2) }, Some(attempt), Some("/wt/kd-app-1"));
    assert!(sim.owed().contains(&Effect::Stop { session }));
    sim.drive();
    assert!(sim.state.ops.is_empty());
}

#[test]
fn a_session_that_shows_up_after_its_close_is_stopped_at_once() {
    let mut sim = Sim::booted();
    sim.intent(close_agent(2));
    sim.drive();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(2) }, None, Some("/wt/kd-app-1"));
    assert!(sim.owed().contains(&Effect::Stop { session }));
}

#[test]
fn a_pane_gets_no_second_launch_while_its_last_session_is_still_alive() {
    let mut sim = Sim::booted();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(3) }, None, Some("/repo"));
    assert_eq!(lease(&mut sim, 3, "/repo"), Answer::refused(Refusal::Busy));
    sim.send(Event::SessionEnded { session });
    assert!(matches!(lease(&mut sim, 3, "/repo"), Answer::Leased { .. }));
}

#[test]
fn without_the_sessions_machine_nothing_launches_and_stops_count_as_unconfirmed() {
    let mut sim = Sim::booted();
    sim.appear(LaunchOwner::Pane { pane: PaneId(2) }, None, Some("/wt/kd-app-1"));
    sim.intent(close_agent(2));
    for _ in 0..3 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    sim.send(Event::SessionsGone);
    assert_eq!(lease(&mut sim, 3, "/repo"), Answer::refused(Refusal::SessionsDown));
    sim.drive();
    assert!(sim.state.ops.is_empty(), "the close did not wait for ever");
}

// ---------------------------------------------------------------- places and ids

#[test]
fn the_first_free_place_skips_what_the_disk_holds_and_two_creations_get_two_numbers() {
    let mut sim = Sim::booted();
    let create = |name: &str| Intent::CreateTeam { workspace: ws(), team: team(name), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] };
    sim.intent(create("a"));
    sim.intent(create("b"));
    let probes: Vec<(OpId, Dir)> = sim
        .owed()
        .into_iter()
        .filter_map(|effect| match effect {
            Effect::Probe { op, path, .. } => Some((op, path)),
            _ => None,
        })
        .collect();
    assert_eq!(probes.iter().map(|(_, path)| path.clone()).collect::<Vec<_>>(), [Dir::new("/wt/kd-app-2"), Dir::new("/wt/kd-app-3")]);
    // The disk holds 2: the first asks again past it, and past 3, which the
    // other one is asking about.
    sim.send(Event::Probed { op: probes[0].0, path: probes[0].1.clone(), taken: true });
    let next = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Probe { op, path, .. } if op == probes[0].0 => Some(path),
        _ => None,
    });
    assert_eq!(next, Some(Dir::new("/wt/kd-app-4")));
}

#[test]
fn a_place_typed_by_hand_meets_the_same_rule_and_is_refused_not_moved() {
    let mut sim = Sim::booted();
    let manual = Site::New { place: Some(Place { path: Dir::new("/wt/kd-app-1"), branch: "mine".into() }), base: None };
    let ask = sim.intent(Intent::CreateTeam { workspace: ws(), team: team("m"), site: manual, draft: draft(), members: vec![] });
    assert_eq!(sim.refusal(ask), Some(Refusal::LocationHeld), "team-1's folder");
    let manual = Site::New { place: Some(Place { path: Dir::new("/wt/free"), branch: "mine".into() }), base: None };
    let ask = sim.intent(Intent::CreateTeam { workspace: ws(), team: team("m"), site: manual, draft: draft(), members: vec![] });
    let (op, path) = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Probe { op, path, .. } => Some((op, path)),
        _ => None,
    }).unwrap();
    sim.send(Event::Probed { op, path, taken: true });
    assert_eq!(sim.refusal(ask), Some(Refusal::LocationHeld), "the disk holds it");
}

#[test]
fn pane_numbers_start_above_the_deck_and_the_journal_and_never_come_back_in_a_launch() {
    let entry = Entry {
        op: OpId(4),
        workspace: ws(),
        work: Work::Close { target: Target::Agent { pane: PaneId(40) }, teams: vec![], panes: vec![PaneId(40)], consent: Consent::default(), removals: vec![] },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let mut sim = Sim::booted_with(deck(), vec![entry]);
    sim.drive();
    let ask = sim.intent(seat("1"));
    sim.drive();
    let Some(Answer::Accepted { minted, .. }) = sim.answer(ask) else { panic!() };
    assert_eq!(minted.panes, [PaneId(41)], "above the journal's 40");
    // Close it: its number is not issued again.
    sim.intent(close_agent(41));
    sim.drive();
    let ask = sim.intent(seat("1"));
    sim.drive();
    let Some(Answer::Accepted { minted, .. }) = sim.answer(ask) else { panic!() };
    assert_eq!(minted.panes, [PaneId(42)]);
}

#[test]
fn a_new_team_or_workspace_id_already_taken_is_refused() {
    let mut sim = Sim::booted();
    let ask = sim.intent(Intent::CreateTeam { workspace: ws(), team: team("1"), site: Site::Root, draft: draft(), members: vec![] });
    assert_eq!(sim.refusal(ask), Some(Refusal::Busy));
    let ask = sim.intent(Intent::CreateWorkspace { workspace: ws(), name: "x".into(), cwd: Dir::new("/x"), worktree_base: None, draft: draft() });
    assert_eq!(sim.refusal(ask), Some(Refusal::Busy));
}

// ---------------------------------------------------------------- boot

#[test]
fn a_restored_close_asks_again_under_the_same_ids_and_forgets_even_what_the_deck_still_holds() {
    let mut first = Sim::booted();
    first.intent(disband("1", Consent::default()));
    first.write_journals();
    first.apply(|cmd| matches!(cmd, Cmd::Retire { .. }));
    first.write_journals();
    let entry = first.disk.values().next().cloned().expect("on disk");
    let remove_id = entry.commands.iter().find(|sent| matches!(sent.command.cmd, Cmd::RemoveTeam { .. })).map(|sent| sent.command.id);
    // The app dies here; the deck on disk still holds team-1.
    let mut sim = Sim::booted_with(deck(), vec![entry.clone()]);
    assert!(sim.state.forgotten.teams.contains(&team("1")), "forgotten from the journal");
    let removes = sim.pending_matching(|cmd| matches!(cmd, Cmd::RemoveTeam { .. }));
    assert_eq!(removes.len(), 1);
    if let Some(id) = remove_id {
        assert_eq!(removes[0].id, id, "the same exact id");
    }
    sim.drive();
    assert!(sim.disk.is_empty());
    assert!(!sim.state.world.teams.contains_key(&team("1")));
}

#[test]
fn an_open_fork_at_boot_is_rolled_back_by_both_discard_lists() {
    let entry = Entry {
        op: OpId(6),
        workspace: ws(),
        work: Work::Fork {
            pane: PaneId(1),
            source: SessionKey { agent: "claude".into(), session: "s".into() },
            team: None,
            ticket: None,
            discard: Some(Discard { plugin: "claude".into(), once_started: vec!["/c/scratch".into()], if_never_started: vec!["/c/copy".into()] }),
        },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let mut sim = Sim::booted_with(deck(), vec![entry]);
    let discard = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Clean { how: Clean::Discard { paths, .. }, .. } => Some(paths),
        _ => None,
    });
    assert_eq!(discard, Some(vec!["/c/scratch".into(), "/c/copy".into()]), "the copy too: the fork did not finish");
    sim.drive();
    assert!(!sim.state.world.panes.contains_key(&PaneId(1)), "its pane leaves the deck");
    assert!(sim.disk.is_empty());
}

#[test]
fn a_creation_entry_whose_team_never_reached_the_deck_takes_back_its_checkout() {
    let entry = Entry {
        op: OpId(3),
        workspace: ws(),
        work: Work::Create {
            team: team("lost"),
            ticket: crate::journal::Ticket { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-7"), branch: "kd/app/7".into(), base: None },
        },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let mut sim = Sim::booted_with(deck(), vec![entry]);
    assert!(sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. }, .. })));
    sim.drive();
    assert!(sim.state.ops.is_empty());
    assert!(sim.disk.is_empty());
}

#[test]
fn a_creation_the_deck_says_was_going_on_with_no_entry_becomes_failed_with_retry() {
    let mut facts = deck();
    facts.workspaces[0].teams.push(TeamFacts { id: team("p"), at: TeamAtFacts::Provisioning { path: Dir::new("/wt/kd-app-5"), branch: Some("kd/app/5".into()) } });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    assert_eq!(snapshot(&sim.state).teams[&team("p")], TeamPhase::Failed);
    assert!(snapshot(&sim.state).gates[&team("p")].retry);
    let ask = sim.intent(Intent::Retry { workspace: ws(), team: team("p") });
    sim.drive();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    assert_eq!(snapshot(&sim.state).teams[&team("p")], TeamPhase::Live);
}

#[test]
fn boot_reconciles_the_stores_tasks_and_mail_of_what_the_deck_no_longer_holds() {
    let mut sim = Sim::booted_with(deck(), Vec::new());
    let teams = sim.pending_matching(|cmd| matches!(cmd, Cmd::RetainTeams { .. }));
    assert_eq!(teams.len(), 1);
    let Cmd::RetainTeams { teams: kept } = &teams[0].cmd else { panic!() };
    assert_eq!(kept, &vec![team("1"), team("r")]);
    let retain = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Clean { how: Clean::Retain { workspaces }, .. } => Some(workspaces),
        _ => None,
    });
    assert_eq!(retain, Some(vec![ws()]));
    sim.drive();
    assert!(sim.state.ops.is_empty());
}

// ---------------------------------------------------------------- the fork

fn fork_into(name: &str) -> Intent {
    Intent::Continue {
        workspace: ws(),
        landing: Landing::Team { team: team(name) },
        source: SessionKey { agent: "claude".into(), session: "s1".into() },
        how: Continuation::Fork,
        member: draft(),
    }
}

/// Run a fork into team-r up to its hook call.
fn forking() -> (Sim, AskId, OpId) {
    let mut sim = Sim::booted();
    let ask = sim.intent(fork_into("r"));
    sim.write_journals();
    let op = *sim.state.ops.keys().next().unwrap();
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::Fork { .. })).len(), 1, "the hook is called after the entry is on disk");
    (sim, ask, op)
}

#[test]
fn a_fork_is_finished_only_once_its_launch_is_bound() {
    let (mut sim, ask, op) = forking();
    sim.apply(|cmd| matches!(cmd, Cmd::Fork { .. }));
    sim.send(Event::HookEnded { op });
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::AddPane { .. })).is_empty(), "not before the discard lists are on disk");
    sim.flush_journals();
    sim.apply(|cmd| matches!(cmd, Cmd::AddPane { .. }));
    sim.save();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::ReportBinding { .. })).len(), 1);
    assert!(sim.disk.contains_key(&op), "open until the binding");
    sim.apply(|cmd| matches!(cmd, Cmd::ReportBinding { .. }));
    let discard = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Clean { how: Clean::Discard { paths, .. }, .. } => Some(paths),
        _ => None,
    });
    assert_eq!(discard, Some(vec!["/c/scratch".to_string()]), "only the once-started scaffolding");
    sim.drive();
    assert!(sim.disk.is_empty());
    assert!(sim.state.world.panes.values().any(|pane| pane.team == Some(team("r"))));
}

#[test]
fn a_fork_whose_session_ends_before_the_binding_is_rolled_back_whole() {
    let (mut sim, ask, op) = forking();
    sim.apply(|cmd| matches!(cmd, Cmd::Fork { .. }));
    sim.send(Event::HookEnded { op });
    sim.flush_journals();
    sim.apply(|cmd| matches!(cmd, Cmd::AddPane { .. }));
    sim.save();
    let Some(Answer::Accepted { minted, .. }) = sim.answer(ask) else { panic!() };
    let pane = minted.panes[0];
    let session = sim.appear(LaunchOwner::Pane { pane }, None, Some("/repo"));
    sim.send(Event::SessionEnded { session });
    let discard = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Clean { how: Clean::Discard { paths, .. }, .. } => Some(paths),
        _ => None,
    });
    assert_eq!(discard, Some(vec!["/c/scratch".to_string(), "/c/copy".to_string()]));
    // A late binding is answered, and changes nothing.
    sim.apply(|cmd| matches!(cmd, Cmd::ReportBinding { .. }));
    sim.drive();
    assert!(!sim.state.world.panes.contains_key(&pane), "its pane leaves the deck");
    assert!(sim.state.forgotten.panes.contains(&pane));
}

#[test]
fn a_fork_hook_past_its_deadline_drops_the_build_and_holds_the_rollback_until_the_call_ends() {
    let (mut sim, ask, op) = forking();
    assert!(sim.timers().contains(&Event::Timer(Timer::Fork { op })));
    sim.send(Event::Timer(Timer::Fork { op }));
    assert_eq!(sim.refusal(ask), Some(Refusal::ForkStepExpired));
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::DropBuild { .. })).len(), 1);
    // A late success: the plan is not taken.
    sim.apply(|cmd| matches!(cmd, Cmd::Fork { .. }));
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::AddPane { .. })).is_empty());
    assert!(sim.state.ops.contains_key(&op), "held until the hook really ended");
    sim.send(Event::HookEnded { op });
    sim.drive();
    assert!(sim.state.ops.is_empty());
}

#[test]
fn a_fork_hook_that_fails_takes_back_nothing_it_did_not_report() {
    let (mut sim, ask, op) = forking();
    sim.reply(|cmd| matches!(cmd, Cmd::Fork { .. }), Outcome::Rejected { reason: "store layout".into() });
    sim.send(Event::HookEnded { op });
    assert_eq!(sim.refusal(ask), Some(Refusal::Rejected { reason: "store layout".into() }));
    sim.drive();
    assert!(!sim.log.iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Discard { .. }, .. })), "a refused fork leaves the store untouched");
    assert!(sim.state.ops.is_empty());
}

// ---------------------------------------------------------------- the commit check

#[test]
fn a_write_from_a_forgotten_workspace_team_or_pane_is_refused_and_only_that() {
    let mut sim = Sim::booted();
    let forgotten = |sim: &Sim, team_name: Option<&str>, pane: Option<u64>| {
        let team = team_name.map(team);
        sim.state.forgotten.source(&ws(), team.as_ref(), pane.map(PaneId).as_ref())
    };
    assert!(!forgotten(&sim, Some("1"), Some(2)));
    sim.intent(close_agent(2));
    sim.write_journals();
    assert!(forgotten(&sim, Some("1"), Some(2)), "the pane is forgotten");
    assert!(!forgotten(&sim, Some("1"), Some(1)), "its team and the other member are not");
    assert!(!forgotten(&sim, None, None));
    sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    sim.drive();
    assert!(forgotten(&sim, None, None), "the whole workspace, once it is closed");
}

// ---------------------------------------------------------------- the snapshot

#[test]
fn the_snapshot_says_a_team_is_leaving_and_closes_its_gates() {
    let mut sim = Sim::booted();
    sim.intent(disband("1", Consent::default()));
    let snap = snapshot(&sim.state);
    assert_eq!(snap.teams[&team("1")], TeamPhase::Leaving);
    assert!(!snap.gates[&team("1")].add_member && !snap.gates[&team("1")].close);
    assert!(snap.gates[&team("r")].add_member);
}
