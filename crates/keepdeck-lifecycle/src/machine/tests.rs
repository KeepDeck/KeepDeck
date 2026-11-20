//! The machine's rules, on plain `update` and `work` — no runtime. A `Sim`
//! plays the world: it hands the machine the events its effects and owners
//! would send, one step at a time or all of them until nothing is owed.

use super::snapshot::{snapshot, Due, TeamGates, TeamPhase};
use super::*;
use crate::command::{Cmd, Outcome, Revision, Why};
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

/// An agent's draft. The lifecycle never reads one, and the core names no
/// CLI: its agent is a neutral one.
fn draft() -> Draft {
    Draft(json!({ "agentType": "cli-a" }))
}

/// An owner's refusal of `kind`, as the machine carries it: opaque.
fn why(kind: &str) -> Why {
    Why(json!({ "kind": kind }))
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
            repo: None,
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
        folders: vec![Folder { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-1"), branch: Some("kd/app/1".into()) }],
        ..Consent::default()
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

    /// A Close as its dialog confirms it: the agents the preview showed are
    /// the ones the person agreed to end.
    fn close(&mut self, mut intent: Intent) -> AskId {
        let shown = super::queries::preview(&self.state, &intent).stops;
        if let Intent::CloseAgent { consent, .. } | Intent::Disband { consent, .. } | Intent::CloseWorkspace { consent, .. } = &mut intent {
            consent.stops = shown;
        }
        self.intent(intent)
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

    fn pending(&self) -> Vec<Due> {
        snapshot(&self.state).commands
    }

    fn pending_matching(&self, pred: impl Fn(&Cmd) -> bool) -> Vec<Due> {
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
        self.round_with(&|_| Ok(()))
    }

    /// One round of a world that does what it is asked, each cleanup step
    /// with the result `step` gives it.
    fn round_with(&mut self, step: &dyn Fn(&Clean) -> StepResult) -> bool {
        let before = self.state.clone();
        self.write_journals();
        for effect in self.owed() {
            let event = match effect {
                Effect::Probe { op, path, .. } => Event::Probed { op, path, taken: false },
                Effect::CreateWorktree { op, .. } => Event::Created { op, result: Ok(()) },
                Effect::FindWorktree { op, .. } => Event::Found { op, found: Ok(true) },
                Effect::ReadBranches { op, path, .. } => Event::BranchesRead { op, path, result: Ok(Vec::new()) },
                Effect::Clean { op, step: done, how, .. } => {
                    let result = step(&how);
                    if result.is_ok() && !self.cleaned.contains(&how) {
                        self.cleaned.push(how);
                    }
                    Event::StepDone { op, step: done, result }
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
        self.drive_with(&|_| Ok(()));
    }

    /// Drive a world whose cleanup steps answer as `step` says.
    fn drive_with(&mut self, step: &dyn Fn(&Clean) -> StepResult) {
        for _ in 0..100 {
            if !self.round_with(step) {
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

// ---------------------------------------------------------------- letting go of a stopped pane

/// What the owners were asked to let go of, in order: each pane, and whether
/// its process is replaced in place.
fn released(sim: &Sim) -> Vec<(PaneId, bool)> {
    sim.carried
        .iter()
        .filter_map(|cmd| match cmd {
            Cmd::Release { pane, in_place, .. } => Some((*pane, *in_place)),
            _ => None,
        })
        .collect()
}

/// The launch lets go of a stopped pane once its session is over — never
/// while the process still runs in the slot it would empty — and once.
#[test]
fn a_stop_releases_its_pane_once_its_session_is_over_and_never_before() {
    let mut sim = Sim::booted();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
    sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(1) });
    sim.write_journals();
    sim.apply(|cmd| matches!(cmd, Cmd::Retire { .. }));
    assert!(sim.owed().contains(&Effect::Stop { session }), "stopping");
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::MarkSuspended { .. })).len(), 1, "the row is marked first");
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::Release { .. })).is_empty(), "not while its session lives");
    sim.send(Event::SessionEnded { session });
    let due: Vec<Cmd> = sim.pending_matching(|cmd| matches!(cmd, Cmd::Release { .. })).into_iter().map(|due| due.cmd).collect();
    assert_eq!(due, vec![Cmd::Release { workspace: ws(), pane: PaneId(1), in_place: false }]);
    sim.drive();
    assert_eq!(released(&sim), vec![(PaneId(1), false)], "once");
}

/// A pane with no session in this launch is let go of all the same: its slot
/// may hold a launch the start boundary cancelled, or an exit card.
#[test]
fn a_stop_releases_a_pane_that_has_no_session() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(1) });
    sim.drive();
    assert_eq!(released(&sim), vec![(PaneId(1), false)]);
}

/// Only a restart keeps its pane and replaces the process in it.
#[test]
fn only_a_restart_releases_its_pane_in_place() {
    for (intent, in_place) in [
        (Intent::Restart { workspace: ws(), pane: PaneId(1) }, true),
        (Intent::Suspend { workspace: ws(), pane: PaneId(1) }, false),
        (close_agent(1), false),
    ] {
        let mut sim = Sim::booted();
        sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
        sim.close(intent.clone());
        sim.drive();
        assert_eq!(released(&sim), vec![(PaneId(1), in_place)], "{intent:?}");
    }
}

/// A teardown of many lets go of each of its panes, and of no other.
#[test]
fn a_teardown_of_many_releases_each_of_its_panes() {
    let mut sim = Sim::booted();
    sim.close(disband("1", consent_for_team_1()));
    sim.drive();
    assert_eq!(released(&sim), vec![(PaneId(1), false), (PaneId(2), false)], "the team's members");

    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    sim.drive();
    assert_eq!(released(&sim), vec![(PaneId(1), false), (PaneId(2), false), (PaneId(3), false)], "the workspace's panes");
}

/// The page's answer is part of the operation: a stop is not over until its
/// panes are let go of.
#[test]
fn a_stop_is_not_over_until_its_pane_is_released() {
    let mut sim = Sim::booted();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
    sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(1) });
    sim.send(Event::SessionEnded { session });
    for _ in 0..5 {
        sim.write_journals();
        sim.apply(|cmd| !matches!(cmd, Cmd::Release { .. }));
        sim.save();
    }
    assert!(!sim.state.ops.is_empty(), "it waits for the release");
    sim.drive();
    assert!(sim.state.ops.is_empty(), "and ends once answered: {:?}", sim.state.ops);
}

/// A teardown restored from its entry has nothing of this launch to let go
/// of: no slot here ever held its panes' processes.
#[test]
fn a_teardown_restored_at_boot_releases_nothing() {
    let close = Entry {
        op: OpId(7),
        workspace: ws(),
        work: Work::Close {
            target: Target::Agent { pane: PaneId(1) },
            teams: vec![],
            panes: vec![PaneId(1)],
            consent: Consent::default(),
            removals: vec![],
            space: None,
        },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let mut sim = Sim::booted_with(deck(), vec![close]);
    sim.drive();
    assert!(sim.state.ops.is_empty(), "the close ran to its end: {:?}", sim.state.ops);
    assert_eq!(released(&sim), vec![]);
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
    let ask = sim.close(disband("1", consent_for_team_1()));
    sim.drive();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    let (repo, path) = (Dir::new("/repo"), Dir::new("/wt/kd-app-1"));
    assert!(sim.cleaned.contains(&Clean::Disarm { dir: path.clone() }));
    assert!(sim.cleaned.contains(&Clean::Checkout { repo: repo.clone(), path }));
    assert!(sim.cleaned.contains(&Clean::Branch { repo, name: "kd/app/1".into() }));
    assert!(!sim.cleaned.iter().any(|clean| matches!(clean, Clean::Stores { .. })), "a team's close leaves the workspace's stores alone");
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
    sim.close(disband("1", consent_for_team_1()));
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
fn a_branch_waits_for_its_own_checkout_not_the_first_of_its_repository() {
    let mut facts = deck();
    facts.workspaces[0].teams.push(TeamFacts { id: team("2"), at: TeamAtFacts::Attached { cwd: Dir::new("/wt/kd-app-2"), branch: Some("kd/app/2".into()) } });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    let whole = Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() };
    let offered = shown(&sim, &whole);
    assert_eq!(offered.folders.len(), 2);
    sim.intent(Intent::CloseWorkspace {
        workspace: ws(),
        consent: Consent { stops: offered.stops, folders: offered.folders, tickets: offered.creations },
    });
    let second = Step::Branch { repo: Dir::new("/repo"), name: "kd/app/2".into() };
    for _ in 0..20 {
        sim.write_journals();
        for effect in sim.owed() {
            let event = match effect {
                Effect::ReadBranches { op, path, .. } => Event::BranchesRead { op, path, result: Ok(Vec::new()) },
                Effect::Stop { session, .. } => Event::SessionEnded { session },
                // The first checkout of the repository goes; the second stays.
                Effect::Clean { op, step, how: Clean::Checkout { path, .. }, .. } if path == Dir::new("/wt/kd-app-1") => Event::StepDone { op, step, result: Ok(()) },
                Effect::Clean { op, step, how: Clean::Disarm { .. } | Clean::Stores { .. } } => Event::StepDone { op, step, result: Ok(()) },
                Effect::Clean { step, .. } if step == second => panic!("the second branch went before its checkout"),
                _ => continue,
            };
            sim.send(event);
        }
        sim.apply(|_| true);
        sim.save();
    }
    assert!(sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { path, .. }, .. } if path == &Dir::new("/wt/kd-app-2"))), "its checkout is owed: {:?}", sim.owed());
}

#[test]
fn a_failed_cleanup_step_keeps_the_entry_and_the_place_and_says_the_worktree_was_not_deleted() {
    let mut sim = Sim::booted();
    sim.close(disband("1", consent_for_team_1()));
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
    sim.close(disband("1", Consent::default()));
    let member = sim.intent(close_agent(1));
    assert_eq!(sim.refusal(member), Some(Refusal::AlreadyClosing));
    let twice = sim.close(disband("1", Consent::default()));
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
    sim.close(disband("1", consent_for_team_1()));
    sim.write_journals();
    let close = sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    assert_eq!(sim.refusal(close), None, "joined, not refused");
    let ops: Vec<&Op> = sim.state.ops.values().collect();
    let joined = ops.iter().find_map(|op| op.teardown().filter(|t| t.kind == model::Teardown::CloseWorkspace).map(|t| t.joined.clone())).unwrap();
    assert_eq!(joined.len(), 1);
    let disband = ops.iter().find_map(|op| op.teardown().filter(|t| t.kind == model::Teardown::Disband)).unwrap();
    assert_eq!(disband.consent.folders, consent_for_team_1().folders, "its own consent stays");
    assert_eq!(disband.consent.stops, vec![PaneId(1), PaneId(2)]);
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
    let ticket = sim
        .owed()
        .into_iter()
        .find_map(|effect| match effect {
            Effect::CreateWorktree { ticket, .. } => Some(ticket),
            _ => None,
        })
        .expect("git is asked to make it");
    let consent = Consent { tickets: vec![create_op], ..Consent::default() };
    let close = sim.close(disband("n", consent));
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
    // The agreed ticket's checkout and branch go once git is done with them.
    assert!(sim.cleaned.contains(&Clean::Checkout { repo: ticket.repo.clone(), path: ticket.path.clone() }), "{:?}", sim.cleaned);
    assert!(sim.cleaned.contains(&Clean::Branch { repo: ticket.repo, name: ticket.branch }));
}

/// A failed creation's card proves nothing about its ticket's path: it is
/// not offered, and a consent naming it deletes nothing.
#[test]
fn a_failed_creation_offers_no_folder_to_delete() {
    let mut facts = deck();
    facts.workspaces[0].teams.push(TeamFacts { id: team("p"), at: TeamAtFacts::Provisioning { path: Dir::new("/wt/kd-app-5"), branch: Some("kd/app/5".into()) } });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    assert_eq!(snapshot(&sim.state).teams[&team("p")], TeamPhase::Failed);
    assert!(shown(&sim, &disband("p", Consent::default())).folders.is_empty(), "not offered");
    let forged = Consent { folders: vec![Folder { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-5"), branch: Some("kd/app/5".into()) }], ..Consent::default() };
    sim.close(disband("p", forged));
    sim.drive();
    assert!(!sim.cleaned.iter().any(|clean| matches!(clean, Clean::Checkout { .. } | Clean::Branch { .. })), "{:?}", sim.cleaned);
}

/// A taken-over creation hands its checkout to its close: its own entry —
/// the other trace of that checkout — stays until the close's entry on disk
/// carries the folder.
#[test]
fn a_handed_over_checkout_is_on_the_closes_entry_before_the_creations_entry_goes() {
    let mut sim = Sim::booted();
    sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
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
    let create_op = *sim.state.ops.keys().next().unwrap();
    sim.close(disband("n", Consent { tickets: vec![create_op], ..Consent::default() }));
    for _ in 0..6 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    let close_op = *sim.state.ops.keys().last().unwrap();
    sim.send(Event::Created { op: create_op, result: Ok(()) });
    let removes_creation = |sim: &Sim| sim.owed().iter().any(|effect| matches!(effect, Effect::RemoveJournal { op, .. } if *op == create_op));
    let close_written_with_folder = |sim: &Sim| {
        sim.disk.get(&close_op).is_some_and(|entry| matches!(&entry.work, Work::Close { consent, .. } if !consent.folders.is_empty()))
    };
    assert!(!close_written_with_folder(&sim));
    assert!(!removes_creation(&sim), "the creation's entry stays while the close's is still without the folder");
    sim.write_journals();
    assert!(close_written_with_folder(&sim));
    assert!(removes_creation(&sim), "then it goes");
}

/// A crash between git's Ok for a taken-over creation and its close's entry
/// holding the checkout: both entries survive. The restored creation joins
/// its close: git is asked whether the checkout stands, nothing is made,
/// and it is handed over only on git's word. Its entry goes once the
/// close's holds the folder.
#[test]
fn a_creation_taken_over_before_a_crash_hands_its_checkout_over_after_it_only_on_gits_word() {
    let ticket = Ticket { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-5"), branch: "kd/app/5".into(), base: None };
    let entry = |op: u64, work: Work| Entry { op: OpId(op), workspace: ws(), work, joined: vec![], commands: vec![], done: vec![] };
    let entries = || {
        vec![
            entry(5, Work::Create { team: team("n"), ticket: ticket.clone() }),
            entry(
                7,
                Work::Close {
                    target: Target::Team { team: team("n") },
                    teams: vec![team("n")],
                    panes: vec![],
                    consent: Consent { tickets: vec![OpId(5)], ..Consent::default() },
                    removals: vec![],
                    space: Some(Dir::new("/repo")),
                },
            ),
        ]
    };
    let deleted = |sim: &Sim| sim.cleaned.iter().any(|how| matches!(how, Clean::Checkout { path, .. } if *path == ticket.path));
    let removes_creation = |sim: &Sim| sim.owed().iter().any(|effect| matches!(effect, Effect::RemoveJournal { op: OpId(5), .. }));

    // Git says the checkout stands: handed over, then deleted.
    let mut sim = Sim::booted_with(deck(), entries());
    let owed = sim.owed();
    assert!(owed.contains(&Effect::FindWorktree { op: OpId(5), ticket: ticket.clone() }), "{owed:?}");
    assert!(!owed.iter().any(|effect| matches!(effect, Effect::CreateWorktree { .. })), "nothing is made");
    sim.send(Event::Found { op: OpId(5), found: Ok(true) });
    let holds = |sim: &Sim| matches!(&sim.disk[&OpId(7)].work, Work::Close { consent, .. } if consent.folders.iter().any(|folder| folder.path == ticket.path));
    for _ in 0..3 {
        if holds(&sim) {
            break;
        }
        assert!(!removes_creation(&sim), "its entry stays while the close's lacks the folder");
        sim.write_journals();
    }
    assert!(holds(&sim), "the close's entry holds the checkout");
    assert!(removes_creation(&sim), "then the creation's goes");
    sim.drive();
    assert!(deleted(&sim), "the close deletes it: {:?}", sim.cleaned);

    // Git says no such checkout stands: nothing is handed over, nothing
    // deleted.
    let mut sim = Sim::booted_with(deck(), entries());
    sim.send(Event::Found { op: OpId(5), found: Ok(false) });
    sim.drive();
    assert!(!deleted(&sim), "{:?}", sim.cleaned);
    assert!(sim.disk.is_empty(), "both done: {:?}", sim.disk.keys());

    // Git could not read the repository: nothing is known. Both stay owed,
    // their entries kept, and the next launch asks again.
    let mut sim = Sim::booted_with(deck(), entries());
    sim.send(Event::Found { op: OpId(5), found: Err("the repository's volume is not mounted".into()) });
    sim.drive();
    assert!(!deleted(&sim), "{:?}", sim.cleaned);
    assert!(sim.state.ops[&OpId(5)].owed && sim.state.ops[&OpId(7)].owed, "both owed");
    assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::RemoveJournal { .. })), "no entry goes");
    assert_eq!(sim.disk.keys().copied().collect::<Vec<_>>(), [OpId(5), OpId(7)]);
    let next = Sim::booted_with(deck(), sim.disk.values().cloned().collect());
    assert!(next.owed().contains(&Effect::FindWorktree { op: OpId(5), ticket: ticket.clone() }), "asked again");
}

/// Git refuses the taken-over creation — the path is another branch's
/// checkout. Nothing proves the folder this ticket's, and it is not deleted.
#[test]
fn a_taken_over_creation_git_refused_hands_its_close_nothing_to_delete() {
    let mut sim = Sim::booted();
    sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
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
    let create_op = *sim.state.ops.keys().next().unwrap();
    let close = sim.close(disband("n", Consent { tickets: vec![create_op], ..Consent::default() }));
    assert_eq!(sim.refusal(close), None);
    for _ in 0..6 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    sim.send(Event::Created { op: create_op, result: Err("already checked out as another branch".into()) });
    sim.drive();
    assert!(sim.state.ops.is_empty());
    assert!(
        !sim.cleaned.iter().any(|clean| matches!(clean, Clean::Checkout { .. } | Clean::Branch { .. })),
        "the folder may be someone else's: {:?}",
        sim.cleaned
    );
}

/// The consent a Close is held to is what is still on offer: a folder
/// another team took since the dialog asked is not deleted, and that team's
/// session in it is not stopped.
#[test]
fn a_folder_another_team_took_since_the_dialog_asked_is_neither_deleted_nor_emptied() {
    let mut facts = deck();
    facts.workspaces[0].teams.push(TeamFacts { id: team("b"), at: TeamAtFacts::Attached { cwd: Dir::new("/wt/kd-app-1"), branch: None } });
    facts.workspaces[0].panes.push(pane_facts(5, Some("b")));
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    let theirs = sim.appear(LaunchOwner::Pane { pane: PaneId(5) }, None, Some("/wt/kd-app-1"));
    // What the dialog showed before team b came: team 1's folder, offered.
    let asked = Consent { stops: vec![PaneId(1), PaneId(2)], ..consent_for_team_1() };
    let close = sim.intent(disband("1", asked));
    assert_eq!(sim.refusal(close), None, "narrowed, not refused");
    sim.drive();
    assert!(!sim.state.sessions[&theirs].ended, "team b's agent keeps running");
    assert!(!sim.cleaned.iter().any(|clean| matches!(clean, Clean::Checkout { .. } | Clean::Branch { .. })), "{:?}", sim.cleaned);
    assert!(!sim.state.world.teams.contains_key(&team("1")) && sim.state.world.teams.contains_key(&team("b")));
}

#[test]
fn a_close_takes_over_an_archive() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    sim.write_journals();
    let close = sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    assert_eq!(sim.refusal(close), None);
    sim.drive();
    assert!(sim.state.world.workspaces.is_empty());
    assert!(sim.state.ops.is_empty());
    assert!(sim.cleaned.contains(&Clean::Stores { workspace: ws() }), "its stores' data goes, by its own name: {:?}", sim.cleaned);
}

/// A Close taking over an archive takes over what the archive was waiting
/// for at the start boundary too: it goes on — and lets go of no slot — only
/// once the boundary has answered for those launches.
#[test]
fn a_close_taking_over_an_archive_waits_for_the_launches_the_archive_took_to_the_boundary() {
    let mut sim = Sim::booted();
    let Answer::Leased { permit } = lease(&mut sim, 1, "/wt/kd-app-1") else { panic!() };
    let Answer::Admitted { attempt } = admit(&mut sim, permit, 1, "/wt/kd-app-1") else { panic!() };
    sim.intent(Intent::Archive { workspace: ws() });
    for _ in 0..3 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    let archive = *sim.state.ops.keys().next().unwrap();
    assert!(sim.owed().contains(&Effect::Cancel { op: archive, attempts: vec![attempt] }), "the archive took it: {:?}", sim.owed());
    let close = sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    assert_eq!(sim.refusal(close), None);
    let close_op = *sim.state.ops.keys().last().unwrap();
    for _ in 0..6 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    assert!(sim.owed().contains(&Effect::Cancel { op: close_op, attempts: vec![attempt] }), "the close waits for the boundary's word: {:?}", sim.owed());
    assert!(sim.pending_matching(|cmd| matches!(cmd, Cmd::Release { .. })).is_empty(), "and lets go of nothing before it");
    sim.send(Event::Cancelled { op: close_op, started: vec![] });
    sim.drive();
    assert!(sim.state.ops.is_empty(), "{:?}", sim.state.ops);
    assert!(sim.state.world.workspaces.is_empty());
}

/// An archive a Close takes over after its stop ends only once the page has
/// answered what it asked — its slots let go of — even when the Close that
/// took it over never gets its entry on disk.
#[test]
fn an_archive_taken_over_after_its_stop_has_its_panes_let_go_of_though_the_close_fails() {
    let mut sim = Sim::booted();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
    sim.intent(Intent::Archive { workspace: ws() });
    for _ in 0..6 {
        sim.write_journals();
        if sim.owed().contains(&Effect::Stop { session }) {
            sim.send(Event::SessionEnded { session });
        }
        sim.apply(|cmd| !matches!(cmd, Cmd::Release { .. }));
        sim.save();
    }
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::Release { .. })).len(), 3, "its slots, still to be let go of");
    let close = sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    let close_op = *sim.state.ops.keys().last().unwrap();
    let Some(Effect::WriteJournal { op, attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::WriteJournal { op, .. } if *op == close_op)) else {
        panic!("the close's first write: {:?}", sim.owed())
    };
    sim.send(Event::JournalWritten { op, attempt, result: Err("disk full".into()) });
    let Some(Effect::RemoveJournal { attempt, .. }) = sim.owed().into_iter().find(|effect| matches!(effect, Effect::RemoveJournal { op, .. } if *op == close_op)) else {
        panic!("a rollback")
    };
    sim.send(Event::JournalRemoved { op, attempt, result: Ok(()) });
    assert_eq!(sim.refusal(close), Some(Refusal::JournalUnavailable));
    sim.drive();
    assert_eq!(released(&sim), vec![(PaneId(1), false), (PaneId(2), false), (PaneId(3), false)]);
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
    sim.close(disband("1", Consent::default()));
    let ask = sim.intent(seat("1"));
    assert_eq!(sim.refusal(ask), Some(Refusal::TargetLeaving));

    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    let ask = sim.intent(seat("r"));
    assert_eq!(sim.refusal(ask), Some(Refusal::Archived));
}

#[test]
fn a_relocate_takes_the_member_to_the_root_team_under_the_role_the_person_picked() {
    let mut sim = Sim::booted();
    let ask = sim.intent(Intent::Relocate { workspace: ws(), pane: PaneId(2), root: team("new-root"), role: Some("reviewer".into()) });
    sim.apply(|cmd| matches!(cmd, Cmd::MovePane { .. }));
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    assert!(
        sim.carried.contains(&Cmd::MovePane { workspace: ws(), pane: PaneId(2), to: team("r"), new_root: false, role: Some("reviewer".into()) }),
        "the workspace's own root team, and the pick: {:?}",
        sim.carried
    );
}

#[test]
fn a_seat_the_role_rule_refuses_hears_the_owners_own_kind() {
    let mut sim = Sim::booted();
    let ask = sim.intent(seat("1"));
    sim.reply(|cmd| matches!(cmd, Cmd::AddPane { .. }), Outcome::Rejected { why: why("role") });
    assert_eq!(sim.refusal(ask), Some(Refusal::Rejected { why: why("role") }));
    assert_eq!(sim.state.world.members(&team("1")).len(), 2, "no pane was added");
    sim.drive();
    assert!(sim.state.ops.is_empty());
}

#[test]
fn a_close_queues_behind_a_seat_begun_before_it_and_takes_the_seated_pane() {
    let mut sim = Sim::booted();
    let seat_ask = sim.intent(seat("1"));
    let close = sim.close(disband("1", Consent::default()));
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
    sim.close(disband("1", Consent::default()));
    sim.reply(|cmd| matches!(cmd, Cmd::AddPane { .. }), Outcome::Rejected { why: why("role") });
    let entry = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::WriteJournal { entry, .. } => Some(entry),
        _ => None,
    });
    let Some(entry) = entry else { panic!("the entry without a save: {:?}", sim.owed()) };
    let Work::Close { panes, .. } = &entry.work else { panic!() };
    assert_eq!(panes, &vec![PaneId(1), PaneId(2)]);
}

/// What a Close dialog previewed is what the person agreed to end.
fn shown(sim: &Sim, intent: &Intent) -> super::queries::Preview {
    super::queries::preview(&sim.state, intent)
}

#[test]
fn a_seat_or_relocate_after_the_dialog_asked_needs_a_new_confirmation() {
    // A member is seated on team 1 after its disband was previewed.
    let mut sim = Sim::booted();
    let asked = shown(&sim, &disband("1", Consent::default())).stops;
    assert_eq!(asked, vec![PaneId(1), PaneId(2)]);
    sim.intent(seat("1"));
    let stale = sim.intent(disband("1", Consent { stops: asked, ..Consent::default() }));
    assert_eq!(sim.refusal(stale), Some(Refusal::Changed));
    assert!(sim.state.ops.values().all(|op| op.teardown().is_none()), "nothing was taken");
    // Asked again, the new preview shows the member still landing, and it goes.
    assert_eq!(shown(&sim, &disband("1", Consent::default())).stops.len(), 3);
    let again = sim.close(disband("1", Consent::default()));
    assert_eq!(sim.refusal(again), None);

    // A member is moved onto the root team while the root's disband is asked.
    let mut sim = Sim::booted();
    let asked = shown(&sim, &disband("r", Consent::default())).stops;
    sim.intent(Intent::Relocate { workspace: ws(), pane: PaneId(2), root: team("new-root"), role: None });
    let stale = sim.intent(disband("r", Consent { stops: asked, ..Consent::default() }));
    assert_eq!(sim.refusal(stale), Some(Refusal::Changed));

    // The same for a whole workspace's close.
    let mut sim = Sim::booted();
    let whole = Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() };
    let asked = shown(&sim, &whole).stops;
    sim.intent(seat("r"));
    let stale = sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: Consent { stops: asked, ..Consent::default() } });
    assert_eq!(sim.refusal(stale), Some(Refusal::Changed));
}

#[test]
fn a_member_that_left_since_the_dialog_asked_only_narrows_the_close() {
    let mut sim = Sim::booted();
    let asked = shown(&sim, &disband("1", Consent::default())).stops;
    sim.close(close_agent(2));
    sim.drive();
    assert_eq!(sim.state.world.members(&team("1")), vec![PaneId(1)]);
    let close = sim.intent(disband("1", Consent { stops: asked, ..consent_for_team_1() }));
    assert_eq!(sim.refusal(close), None);
    sim.drive();
    assert!(!sim.state.world.teams.contains_key(&team("1")));
    assert!(sim.cleaned.iter().any(|clean| matches!(clean, Clean::Checkout { .. })), "its agreed folder goes: {:?}", sim.cleaned);
}

#[test]
fn a_worktree_offered_since_the_dialog_asked_asks_again_only_when_deleting_was_agreed() {
    let mut sim = Sim::booted();
    let whole = Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() };
    let asked = shown(&sim, &whole);
    let agreed = Consent { stops: asked.stops.clone(), folders: asked.folders.clone(), tickets: asked.creations.clone() };
    assert!(!agreed.folders.is_empty());
    // A new team's worktree starts being made after the dialog asked.
    sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
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
    assert_eq!(shown(&sim, &whole).creations.len(), 1, "the dialog would now offer it");

    let stale = sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: agreed });
    assert_eq!(sim.refusal(stale), Some(Refusal::Changed), "deleting what it showed would leave what it did not");
    // Keeping every folder, it deletes nothing it did not show: it goes.
    let kept = sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: Consent { stops: asked.stops, ..Consent::default() } });
    assert_eq!(sim.refusal(kept), None);
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
    sim.close(disband("1", Consent::default()));
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
fn a_checkout_with_a_launch_admitted_into_it_is_not_unheld() {
    let mut sim = Sim::booted();
    let owner = LaunchOwner::Plugin { plugin: "run".into(), workspace: ws() };
    let dir = Dir::new("/wt/kd-app-old");
    let ask = sim.next_ask();
    sim.send(Event::Lease { ask, lease: LeaseAsk::Launch { workspace: ws(), owner: owner.clone(), dir: Some(dir.clone()) } });
    let Some(Answer::Leased { permit }) = sim.answer(ask) else { panic!() };
    let ask = sim.next_ask();
    sim.send(Event::Admit { ask, permit, owner: owner.clone(), dir: Some(dir.clone()) });
    let Some(Answer::Admitted { attempt }) = sim.answer(ask) else { panic!() };
    // Admitted, not yet a session: the process may cross into it any moment.
    // The worktree table hears the same hold the removal meets.
    assert_eq!(super::queries::claims(&sim.state, &dir), vec![super::queries::Claim::Launch { attempt }]);
    let remove = sim.intent(Intent::RemoveUnheld { workspace: ws(), path: dir.clone(), tag: None });
    assert_eq!(sim.refusal(remove), Some(Refusal::Busy));
    // Once the launch is a session and over, the folder is free.
    let session = sim.appear(owner, Some(attempt), Some("/wt/kd-app-old"));
    sim.send(Event::SessionEnded { session });
    let remove = sim.intent(Intent::RemoveUnheld { workspace: ws(), path: dir, tag: None });
    assert_eq!(sim.refusal(remove), None);
}

/// An orphan's removal keeps the repository it was accepted for: restored
/// with its workspace's row gone, it still removes from it. An entry written
/// before it kept one, with nothing to take it from, is owed — never left
/// neither running nor ending.
#[test]
fn an_orphan_removal_needs_no_workspace_row_to_finish() {
    let unheld = |op: u64, repo: Option<&str>| Entry {
        op: OpId(op),
        workspace: WorkspaceId("ws-gone".into()),
        work: Work::RemoveUnheld { path: Dir::new("/wt/orphan"), tag: None, repo: repo.map(Dir::new) },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let mut sim = Sim::booted_with(deck(), vec![unheld(3, Some("/repo")), unheld(4, None)]);
    let owed = sim.owed();
    assert!(
        owed.iter().any(|effect| matches!(effect, Effect::Clean { op: OpId(3), how: Clean::Checkout { repo, .. }, .. } if *repo == Dir::new("/repo"))),
        "removed from the repository its entry keeps: {owed:?}"
    );
    sim.drive();
    assert!(!sim.state.ops.contains_key(&OpId(3)), "and done");
    assert!(sim.state.ops[&OpId(4)].owed, "nothing to remove from: owed");
}

#[test]
fn two_permits_for_one_pane_admit_only_one_launch() {
    let mut sim = Sim::booted();
    let Answer::Leased { permit: first } = lease(&mut sim, 1, "/wt/kd-app-1") else { panic!() };
    let Answer::Leased { permit: second } = lease(&mut sim, 1, "/wt/kd-app-1") else { panic!("both leased before either is spent") };
    assert!(matches!(admit(&mut sim, first, 1, "/wt/kd-app-1"), Answer::Admitted { .. }));
    assert_eq!(admit(&mut sim, second, 1, "/wt/kd-app-1"), Answer::refused(Refusal::Busy));
    assert_eq!(sim.state.attempts.len(), 1);
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

/// Two workspaces may be one repository: a place one holds is not given to
/// the other.
#[test]
fn a_place_held_in_one_workspace_is_not_given_in_another() {
    let mut facts = deck();
    facts.workspaces.push(WorkspaceFacts {
        id: WorkspaceId("ws-b".into()),
        name: "app".into(),
        cwd: Dir::new("/repo"),
        worktree_base: Some(Dir::new("/wt")),
        archived: false,
        archiving: false,
            repo: None,
        teams: vec![],
        panes: vec![],
    });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    let other = WorkspaceId("ws-b".into());
    // A creation still probing in the first workspace holds its candidate.
    sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
    sim.write_journals();
    sim.intent(Intent::CreateTeam { workspace: other.clone(), team: team("m"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
    sim.write_journals();
    let probed: Vec<Dir> = sim
        .owed()
        .into_iter()
        .filter_map(|effect| match effect {
            Effect::Probe { path, .. } => Some(path),
            _ => None,
        })
        .collect();
    assert_eq!(probed.len(), 2, "{probed:?}");
    assert_ne!(probed[0], probed[1], "one place, given once");
    assert!(!probed.contains(&Dir::new("/wt/kd-app-1")), "team-1's folder, held in the other workspace");
    let typed = Place { path: Dir::new("/wt/kd-app-1"), branch: "fresh".into() };
    assert!(super::queries::check(&sim.state, &other, &typed).is_some(), "a typed place meets the same rule");
}

/// A branch name is unique within its repository: another checkout of the
/// same one is held to it, an unrelated repository is not.
#[test]
fn a_branch_is_held_within_its_repository_and_not_across_unrelated_ones() {
    let mut facts = deck();
    facts.workspaces[0].repo = Some(Dir::new("/repo/.git"));
    let workspace = |id: &str, cwd: &str, repo: &str| WorkspaceFacts {
        id: WorkspaceId(id.into()),
        name: "app".into(),
        cwd: Dir::new(cwd),
        worktree_base: Some(Dir::new("/elsewhere")),
        archived: false,
        archiving: false,
        repo: Some(Dir::new(repo)),
        teams: vec![],
        panes: vec![],
    };
    facts.workspaces.push(workspace("ws-b", "/other", "/other/.git"));
    facts.workspaces.push(workspace("ws-c", "/wt/kd-app-9", "/repo/.git"));
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    // team-1 of the first workspace stands on kd/app/1.
    let typed = Place { path: Dir::new("/elsewhere/kd-app-x"), branch: "kd/app/1".into() };
    assert_eq!(super::queries::check(&sim.state, &WorkspaceId("ws-b".into()), &typed), None, "an unrelated repository's branch");
    assert_eq!(
        super::queries::check(&sim.state, &WorkspaceId("ws-c".into()), &typed),
        Some(super::queries::PlaceHeld::Team),
        "another checkout of the same repository"
    );
}

/// Two more workspaces: one of an unrelated repository, one another checkout
/// of the first's.
fn beside_another_and_a_twin(facts: &mut DeckFacts) -> (WorkspaceId, WorkspaceId) {
    let workspace = |id: &str, cwd: &str, repo: &str| WorkspaceFacts {
        id: WorkspaceId(id.into()),
        name: "other".into(),
        cwd: Dir::new(cwd),
        worktree_base: Some(Dir::new("/elsewhere")),
        archived: false,
        archiving: false,
        repo: Some(Dir::new(repo)),
        teams: vec![],
        panes: vec![],
    };
    facts.workspaces.push(workspace("ws-b", "/other", "/other/.git"));
    facts.workspaces.push(workspace("ws-c", "/wt/kd-app-9", "/repo/.git"));
    (WorkspaceId("ws-b".into()), WorkspaceId("ws-c".into()))
}

/// A closed workspace's cleanup still owes a branch, and its row is gone:
/// the close keeps its repository with the reservation, so the branch stays
/// held for another checkout of that repository, and an unrelated one is
/// free of it.
#[test]
fn a_branch_a_closed_workspaces_cleanup_still_owes_stays_held_within_its_repository_without_its_row() {
    let mut facts = deck();
    facts.workspaces[0].repo = Some(Dir::new("/repo/.git"));
    let (other, twin) = beside_another_and_a_twin(&mut facts);
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    let typed = Place { path: Dir::new("/elsewhere/kd-other-1"), branch: "kd/app/1".into() };
    assert_eq!(super::queries::check(&sim.state, &other, &typed), None, "an unrelated repository's branch, while it lives");
    let whole = Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() };
    let asked = shown(&sim, &whole);
    sim.intent(Intent::CloseWorkspace { workspace: ws(), consent: Consent { stops: asked.stops, folders: asked.folders, tickets: asked.creations } });
    let branch = Step::Branch { repo: Dir::new("/repo"), name: "kd/app/1".into() };
    for _ in 0..20 {
        sim.write_journals();
        for effect in sim.owed() {
            let event = match effect {
                Effect::ReadBranches { op, path, .. } => Event::BranchesRead { op, path, result: Ok(Vec::new()) },
                Effect::Stop { session, .. } => Event::SessionEnded { session },
                // The branch's step is still owed.
                Effect::Clean { step, .. } if step == branch => continue,
                Effect::Clean { op, step, .. } => Event::StepDone { op, step, result: Ok(()) },
                _ => continue,
            };
            sim.send(event);
        }
        sim.apply(|_| true);
        sim.save();
    }
    assert!(!sim.state.world.workspaces.contains_key(&ws()), "the closed workspace's row is gone");
    assert!(super::queries::check(&sim.state, &twin, &typed).is_some(), "its owed branch is still held in its repository");
    assert_eq!(super::queries::check(&sim.state, &other, &typed), None, "and not in an unrelated one");
    let op = *sim.state.ops.keys().next().unwrap();
    assert!(matches!(&sim.disk[&op].work, Work::Close { space: Some(space), .. } if *space == Dir::new("/repo/.git")), "kept on disk");
}

/// The same reservation restored from its entry after the workspace's row
/// went: its branches — the plan's, and the consent's before a plan is
/// read — are counted by the repository the entry keeps.
#[test]
fn a_restored_close_holds_its_branches_by_the_repository_its_entry_keeps() {
    let mut facts = deck();
    let (other, twin) = beside_another_and_a_twin(&mut facts);
    facts.workspaces.remove(0);
    let close = Entry {
        op: OpId(7),
        workspace: ws(),
        work: Work::Close {
            target: Target::Workspace,
            teams: vec![team("1")],
            panes: vec![],
            consent: consent_for_team_1(),
            removals: vec![crate::journal::Removal { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-1"), branches: vec!["feature".into()] }],
            space: Some(Dir::new("/repo/.git")),
        },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let sim = Sim::booted_with(facts, vec![close]);
    assert!(sim.state.ops.contains_key(&OpId(7)), "restored, its cleanup owed");
    for branch in ["feature", "kd/app/1"] {
        let typed = Place { path: Dir::new("/elsewhere/kd-other-1"), branch: branch.into() };
        assert!(super::queries::check(&sim.state, &twin, &typed).is_some(), "{branch}: held in its repository");
        assert_eq!(super::queries::check(&sim.state, &other, &typed), None, "{branch}: not in an unrelated one");
    }
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
        work: Work::Close { target: Target::Agent { pane: PaneId(40) }, teams: vec![], panes: vec![PaneId(40)], consent: Consent::default(), removals: vec![], space: None },
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
    let ask = sim.intent(Intent::CreateWorkspace { workspace: ws(), name: "x".into(), cwd: Dir::new("/x"), worktree_base: None, draft: draft(), repo: None });
    assert_eq!(sim.refusal(ask), Some(Refusal::Busy));
}

// ---------------------------------------------------------------- boot

#[test]
fn a_restored_close_asks_again_under_the_same_ids_and_forgets_even_what_the_deck_still_holds() {
    let mut first = Sim::booted();
    first.close(disband("1", Consent::default()));
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

/// The window between an owner's answer and the deck's save: the journal
/// must not take an applied deck command for a settled one.
#[test]
fn a_deck_command_applied_but_not_saved_is_asked_again_after_a_crash() {
    let mut first = Sim::booted();
    first.close(disband("1", Consent::default()));
    for _ in 0..4 {
        first.write_journals();
        first.apply(|cmd| !matches!(cmd, Cmd::RemoveTeam { .. }));
        first.save();
    }
    first.apply(|cmd| matches!(cmd, Cmd::RemoveTeam { .. }));
    first.flush_journals();
    let entry = first.disk.values().next().cloned().expect("on disk");
    let remove = entry.commands.iter().find(|sent| matches!(sent.command.cmd, Cmd::RemoveTeam { .. })).expect("sent");
    assert!(!remove.settled, "applied, but the deck holding it is not saved yet");
    // The app dies before the save; the deck on disk still holds team-1.
    let mut sim = Sim::booted_with(deck(), vec![entry]);
    assert_eq!(sim.pending_matching(|cmd| matches!(cmd, Cmd::RemoveTeam { .. })).len(), 1, "asked again");
    sim.drive();
    assert!(!sim.state.world.teams.contains_key(&team("1")));

    // Saved, it is written settled.
    first.save();
    first.flush_journals();
    let entry = first.disk.values().next().cloned().expect("on disk");
    assert!(entry.commands.iter().any(|sent| matches!(sent.command.cmd, Cmd::RemoveTeam { .. }) && sent.settled));
}

#[test]
fn a_refused_command_comes_back_from_the_journal_refused() {
    let mut first = Sim::booted();
    first.close(disband("1", Consent::default()));
    first.write_journals();
    first.reply(|cmd| matches!(cmd, Cmd::Retire { pane, .. } if *pane == PaneId(1)), Outcome::Rejected { why: why("gone") });
    first.flush_journals();
    let entry = first.disk.values().next().cloned().expect("on disk");
    let retire = entry.commands.iter().find(|sent| matches!(sent.command.cmd, Cmd::Retire { pane, .. } if pane == PaneId(1))).expect("sent");
    assert_eq!((retire.settled, retire.rejected.as_ref()), (true, Some(&why("gone"))));
    let sim = Sim::booted_with(deck(), vec![entry]);
    let op = sim.state.ops.values().next().expect("restored");
    assert!(op.sent.iter().any(|sent| sent.rejected() == Some(&why("gone"))), "a refusal, not an application");
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

/// An open fork whose pane is gone from the deck, with no team of its own:
/// it knows no team it landed on — none is made up — and is taken back.
#[test]
fn an_open_fork_with_neither_pane_nor_team_knows_no_team_and_is_taken_back() {
    let entry = Entry {
        op: OpId(6),
        workspace: ws(),
        work: Work::Fork {
            pane: PaneId(77),
            source: SessionKey { agent: "claude".into(), session: "s".into() },
            team: None,
            ticket: None,
            discard: Some(Discard { plugin: "claude".into(), once_started: vec![], if_never_started: vec!["/c/copy".into()] }),
        },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let mut sim = Sim::booted_with(deck(), vec![entry]);
    assert!(matches!(&sim.state.ops[&OpId(6)].kind, Kind::Fork(fork) if fork.team.is_none()), "no team made up");
    sim.drive();
    assert!(sim.disk.is_empty(), "taken back");
}

#[test]
fn a_quarantined_deck_removes_nothing_a_restored_operation_owes_and_keeps_its_entry() {
    let fork = Entry {
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
    let mut sim = Sim::new(Some(vec![fork]));
    let ask = sim.next_ask();
    sim.send(Event::Handshake { ask, deck: deck(), load: Load::Quarantined });
    for _ in 0..6 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
        assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { .. })), "no removal: {:?}", sim.owed());
    }
    assert!(sim.disk.contains_key(&OpId(6)), "the debt stays in the journal for a launch that reads the deck whole");
}

#[test]
fn a_quarantined_deck_holds_a_restored_close_whole_its_forgetting_included() {
    let close = Entry {
        op: OpId(7),
        workspace: ws(),
        work: Work::Close {
            target: Target::Workspace,
            teams: vec![team("1"), team("r")],
            panes: vec![PaneId(1), PaneId(2), PaneId(3)],
            consent: Consent { stops: vec![PaneId(1), PaneId(2), PaneId(3)], ..consent_for_team_1() },
            removals: vec![],
            space: None,
        },
        joined: vec![],
        // A launch that loaded the deck had already sent the forgetting, and
        // died before the owner carried it.
        commands: vec![crate::journal::Sent {
            command: crate::command::Command { id: CommandId { op: OpId(7), index: 0 }, cmd: Cmd::ForgetBoards { workspace: ws() } },
            settled: false,
            rejected: None,
        }],
        done: vec![],
    };
    let mut sim = Sim::new(Some(vec![close]));
    let ask = sim.next_ask();
    sim.send(Event::Handshake { ask, deck: deck(), load: Load::Quarantined });
    sim.drive();
    let forgetting = |cmd: &Cmd| matches!(cmd, Cmd::ForgetBoards { .. } | Cmd::ForgetPaneMail { .. } | Cmd::DeleteTeamTasks { .. });
    assert!(!sim.carried.iter().any(forgetting), "no owner forgets on a quarantined deck: {:?}", sim.carried);
    assert!(!sim.pending().iter().any(|due| forgetting(&due.cmd)), "not even handed to its owner");
    assert!(sim.cleaned.is_empty(), "nothing removed: {:?}", sim.cleaned);
    assert!(sim.disk.contains_key(&OpId(7)), "the close waits whole, its entry on disk, for a launch that reads the deck");
    assert!(sim.disk[&OpId(7)].commands.iter().any(|sent| sent.command.id == CommandId { op: OpId(7), index: 0 } && !sent.settled), "kept, under its id");
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
    assert_eq!(snapshot(&sim.state).gates[&team("p")].retry, None);
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
    // What the late hook made is still taken back — both lists, as for any
    // fork that did not finish.
    assert!(
        sim.cleaned.contains(&Clean::Discard { plugin: "claude".into(), paths: vec!["/c/scratch".into(), "/c/copy".into()] }),
        "the late result's scaffolding: {:?}",
        sim.cleaned
    );
}

/// The fork's helpers in its own checkout: a process the hook left running
/// there stops before the checkout goes, and the scaffolding goes first.
#[test]
fn a_fork_rolled_back_stops_what_runs_in_its_checkout_and_removes_one_step_after_the_other() {
    let mut sim = Sim::booted();
    let ask = sim.intent(Intent::Continue {
        workspace: ws(),
        landing: Landing::NewTeam { team: team("f"), site: Site::New { place: None, base: None }, draft: draft() },
        source: SessionKey { agent: "claude".into(), session: "s1".into() },
        how: Continuation::Fork,
        member: draft(),
    });
    let mut checkout = None;
    for _ in 0..8 {
        sim.write_journals();
        for effect in sim.owed() {
            match effect {
                Effect::Probe { op, path, .. } => sim.send(Event::Probed { op, path, taken: false }),
                Effect::CreateWorktree { op, ticket } => {
                    checkout = Some(ticket.path.clone());
                    sim.send(Event::Created { op, result: Ok(()) });
                }
                _ => {}
            }
        }
        sim.apply(|cmd| !matches!(cmd, Cmd::Fork { .. }));
        sim.save();
    }
    let checkout = checkout.expect("the fork's worktree");
    let op = *sim.state.ops.keys().next().unwrap();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })), "a new team's fork is answered before its hook");
    // The hook runs past its deadline.
    sim.send(Event::Timer(Timer::Fork { op }));
    assert!(matches!(&sim.state.ops[&op].kind, Kind::Fork(fork) if fork.stage == ForkStage::Undoing));
    let cleans = |sim: &Sim| sim.owed().into_iter().filter(|effect| matches!(effect, Effect::Clean { .. })).count();
    // Its end arrives before its answer: nothing goes yet, the checkout
    // quiet as it is — the answer may still name what it made.
    sim.send(Event::HookEnded { op });
    sim.flush_journals();
    assert_eq!(cleans(&sim), 0, "the hook's answer is not in");
    // A helper the hook started registers late in the checkout; then the
    // late answer, with its lists: still nothing goes while the helper runs.
    let helper = sim.appear(LaunchOwner::Plugin { plugin: "claude".into(), workspace: ws() }, None, Some(checkout.as_str()));
    sim.apply(|cmd| matches!(cmd, Cmd::Fork { .. }));
    sim.flush_journals();
    assert!(sim.owed().contains(&Effect::Stop { session: helper }), "the helper stops first");
    assert_eq!(cleans(&sim), 0, "neither the scaffolding nor the checkout while it runs");
    // Nothing new is let into the checkout meanwhile.
    let late = sim.next_ask();
    sim.send(Event::Lease { ask: late, lease: LeaseAsk::Launch { workspace: ws(), owner: LaunchOwner::Plugin { plugin: "claude".into(), workspace: ws() }, dir: Some(checkout.clone()) } });
    assert_eq!(sim.refusal(late), Some(Refusal::TargetLeaving));
    sim.send(Event::SessionEnded { session: helper });
    let discard = sim.owed().into_iter().find_map(|effect| match effect {
        Effect::Clean { op, step, how: Clean::Discard { paths, .. }, .. } => Some((op, step, paths)),
        _ => None,
    });
    let Some((op_id, step, paths)) = discard else { panic!("then the scaffolding goes: {:?}", sim.owed()) };
    assert_eq!(paths, vec!["/c/scratch".to_string(), "/c/copy".to_string()]);
    assert!(!sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. }, .. })), "one step after the other");
    sim.send(Event::StepDone { op: op_id, step, result: Ok(()) });
    assert!(sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. }, .. })), "then the checkout goes");
}

/// A launch admitted into the fork's checkout before the fork was taken
/// back: taken to the start boundary — cancelled if its process does not
/// exist, stopped by id if it does — before the checkout goes.
#[test]
fn a_launch_admitted_into_a_forks_checkout_before_its_undo_goes_to_the_start_boundary() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Continue {
        workspace: ws(),
        landing: Landing::NewTeam { team: team("f"), site: Site::New { place: None, base: None }, draft: draft() },
        source: SessionKey { agent: "claude".into(), session: "s1".into() },
        how: Continuation::Fork,
        member: draft(),
    });
    let mut checkout = None;
    for _ in 0..8 {
        sim.write_journals();
        for effect in sim.owed() {
            match effect {
                Effect::Probe { op, path, .. } => sim.send(Event::Probed { op, path, taken: false }),
                Effect::CreateWorktree { op, ticket } => {
                    checkout = Some(ticket.path.clone());
                    sim.send(Event::Created { op, result: Ok(()) });
                }
                _ => {}
            }
        }
        sim.apply(|cmd| !matches!(cmd, Cmd::Fork { .. }));
        sim.save();
    }
    let checkout = checkout.expect("the fork's worktree");
    let op = *sim.state.ops.keys().next().unwrap();
    // A helper's launch is admitted into the checkout while the hook runs.
    let owner = LaunchOwner::Plugin { plugin: "claude".into(), workspace: ws() };
    let ask = sim.next_ask();
    sim.send(Event::Lease { ask, lease: LeaseAsk::Launch { workspace: ws(), owner: owner.clone(), dir: Some(checkout.clone()) } });
    let Some(Answer::Leased { permit }) = sim.answer(ask) else { panic!() };
    let ask = sim.next_ask();
    sim.send(Event::Admit { ask, permit, owner: owner.clone(), dir: Some(checkout.clone()) });
    let Some(Answer::Admitted { attempt }) = sim.answer(ask) else { panic!() };
    // The hook fails; the fork is taken back.
    sim.reply(|cmd| matches!(cmd, Cmd::Fork { .. }), Outcome::Rejected { why: why("failed") });
    sim.send(Event::HookEnded { op });
    sim.flush_journals();
    assert!(sim.owed().contains(&Effect::Cancel { op, attempts: vec![attempt] }), "cancelled at the start boundary: {:?}", sim.owed());
    let removes_checkout = |sim: &Sim| sim.owed().iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Checkout { .. }, .. }));
    assert!(!removes_checkout(&sim), "not before the boundary's word");
    // Its process had started: awaited, then stopped by id.
    sim.send(Event::Cancelled { op, started: vec![attempt] });
    assert!(sim.timers().contains(&Event::Timer(Timer::Registration { op })));
    assert!(!removes_checkout(&sim));
    let session = sim.appear(owner, Some(attempt), Some(checkout.as_str()));
    assert!(sim.owed().contains(&Effect::Stop { session }));
    assert!(!removes_checkout(&sim));
    sim.send(Event::SessionEnded { session });
    assert!(removes_checkout(&sim), "then the checkout goes");
}

/// A fork into a folder that is there, onto a new team: the hook is called
/// in that folder, and the team settles there — not in the workspace's own.
#[test]
fn a_fork_onto_a_new_team_in_an_existing_folder_calls_its_hook_there_and_settles_there() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Continue {
        workspace: ws(),
        landing: Landing::NewTeam { team: team("e"), site: Site::Existing { cwd: Dir::new("/repo/tools") }, draft: draft() },
        source: SessionKey { agent: "claude".into(), session: "s1".into() },
        how: Continuation::Fork,
        member: draft(),
    });
    for _ in 0..6 {
        sim.write_journals();
        sim.apply(|cmd| !matches!(cmd, Cmd::Fork { .. }));
        sim.save();
    }
    let forks = sim.pending_matching(|cmd| matches!(cmd, Cmd::Fork { .. }));
    assert_eq!(forks.len(), 1, "the hook is called: {:?}", sim.pending());
    assert!(matches!(&forks[0].cmd, Cmd::Fork { cwd, .. } if cwd == &Dir::new("/repo/tools")));
    sim.reply(|cmd| matches!(cmd, Cmd::Fork { .. }), Outcome::Forked { discard: Discard::default() });
    let op = forks[0].id.op;
    sim.send(Event::HookEnded { op });
    for _ in 0..4 {
        sim.write_journals();
        sim.apply(|cmd| !matches!(cmd, Cmd::SettleTeam { .. }));
        sim.save();
    }
    let settles = sim.pending_matching(|cmd| matches!(cmd, Cmd::SettleTeam { .. }));
    assert!(matches!(&settles[..], [due] if matches!(&due.cmd, Cmd::SettleTeam { cwd, .. } if cwd == &Dir::new("/repo/tools"))), "{settles:?}");
}

#[test]
fn a_fork_hook_that_fails_takes_back_nothing_it_did_not_report() {
    let (mut sim, ask, op) = forking();
    sim.reply(|cmd| matches!(cmd, Cmd::Fork { .. }), Outcome::Rejected { why: why("failed") });
    sim.send(Event::HookEnded { op });
    assert_eq!(sim.refusal(ask), Some(Refusal::Rejected { why: why("failed") }));
    sim.drive();
    assert!(!sim.log.iter().any(|effect| matches!(effect, Effect::Clean { how: Clean::Discard { .. }, .. })), "a refused fork leaves the store untouched");
    assert!(sim.state.ops.is_empty());
}

/// A fork step that answers without carrying the conversation — neither
/// forked nor refused — leaves a fork that did not finish: said as its own
/// kind, no words of the machine's.
#[test]
fn a_fork_step_that_carried_nothing_is_a_fork_unfinished() {
    let (mut sim, ask, op) = forking();
    sim.reply(|cmd| matches!(cmd, Cmd::Fork { .. }), Outcome::Applied { revision: None });
    sim.send(Event::HookEnded { op });
    assert_eq!(sim.refusal(ask), Some(Refusal::ForkUnfinished));
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
    sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    sim.drive();
    assert!(forgotten(&sim, None, None), "the whole workspace, once it is closed");
}

/// A launch that died with closes in its journal: what they end is forgotten
/// from the machine's start — before the deck has loaded, before any door
/// opens — so no write lands for it in the window before the handshake.
#[test]
fn the_journals_closes_are_forgotten_from_the_machines_start() {
    let close = |op: u64, workspace: &str, target: Target, teams: Vec<TeamId>, panes: Vec<PaneId>| Entry {
        op: OpId(op),
        workspace: WorkspaceId(workspace.into()),
        work: Work::Close { target, teams, panes, consent: Consent::default(), removals: vec![], space: None },
        joined: vec![],
        commands: vec![],
        done: vec![],
    };
    let state = State::start(Some(vec![
        close(1, "ws-gone", Target::Workspace, vec![team("g")], vec![PaneId(5)]),
        close(2, "ws-b", Target::Team { team: team("d") }, vec![team("d")], vec![PaneId(6)]),
        close(3, "ws-b", Target::Agent { pane: PaneId(7) }, vec![], vec![PaneId(7)]),
    ]));
    let forgotten = &snapshot(&state).forgotten;
    assert!(forgotten.workspaces.contains(&WorkspaceId("ws-gone".into())));
    assert_eq!(forgotten.teams, [team("d"), team("g")].into_iter().collect());
    assert_eq!(forgotten.panes, [PaneId(5), PaneId(6), PaneId(7)].into_iter().collect());
    assert!(!forgotten.workspaces.contains(&WorkspaceId("ws-b".into())), "a team's or an agent's close forgets no workspace");
    assert!(state.forgotten.source(&WorkspaceId("ws-b".into()), Some(&team("d")), None), "the commit check refuses now");
}

// ---------------------------------------------------------------- the snapshot

#[test]
fn the_snapshot_says_a_team_is_leaving_and_closes_its_gates() {
    let mut sim = Sim::booted();
    sim.close(disband("1", Consent::default()));
    let snap = snapshot(&sim.state);
    assert_eq!(snap.teams[&team("1")], TeamPhase::Leaving);
    assert_eq!(snap.gates[&team("1")], TeamGates { add_member: Some(Refusal::TargetLeaving), close: Some(Refusal::AlreadyClosing), retry: Some(Refusal::NotFound) });
    assert_eq!(snap.gates[&team("r")], TeamGates { add_member: None, close: None, retry: Some(Refusal::NotFound) });
}

/// Each gate is the refusal its intent then meets — the offer and the
/// answer read one rule.
#[test]
fn a_gate_says_exactly_what_its_intent_then_meets() {
    let gate_then_intent = |sim: &mut Sim, name: &str| {
        let gates = snapshot(&sim.state).gates[&team(name)].clone();
        let seat = sim.intent(seat(name));
        let retry = sim.intent(Intent::Retry { workspace: ws(), team: team(name) });
        let close = sim.close(disband(name, Consent::default()));
        assert_eq!((sim.refusal(seat), sim.refusal(close), sim.refusal(retry)), (gates.add_member.clone(), gates.close.clone(), gates.retry.clone()), "{name}");
        gates
    };

    let mut sim = Sim::booted();
    sim.close(disband("1", Consent::default()));
    assert_eq!(gate_then_intent(&mut sim, "1").add_member, Some(Refusal::TargetLeaving));

    // An archive under way: nothing lands and no creation is retried, but a
    // Close takes the archive over.
    let mut facts = deck();
    facts.workspaces[0].teams.push(TeamFacts { id: team("p"), at: TeamAtFacts::Provisioning { path: Dir::new("/wt/kd-app-5"), branch: Some("kd/app/5".into()) } });
    let mut sim = Sim::booted_with(facts.clone(), Vec::new());
    sim.drive();
    sim.intent(Intent::Archive { workspace: ws() });
    let gates = gate_then_intent(&mut sim, "p");
    assert_eq!((gates.add_member, gates.retry), (Some(Refusal::Archived), Some(Refusal::Archived)));
    assert_eq!(gates.close, None);

    // A retry under way: a second one is busy.
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    sim.intent(Intent::Retry { workspace: ws(), team: team("p") });
    assert_eq!(snapshot(&sim.state).gates[&team("p")].retry, Some(Refusal::Busy));

    // A deck too new to work on only shows: every gate is the barrier.
    let mut view = Sim::new(Some(Vec::new()));
    let ask = view.next_ask();
    view.send(Event::Handshake { ask, deck: deck(), load: Load::Newer });
    let barrier = Some(Refusal::BarrierUp);
    assert_eq!(snapshot(&view.state).gates[&team("r")], TeamGates { add_member: barrier.clone(), close: barrier.clone(), retry: barrier });
}

/// A Close dialog says the refusal its confirm would meet — the same rule.
#[test]
fn a_close_previews_exactly_the_refusal_its_confirm_meets() {
    let same = |sim: &mut Sim, intent: Intent| {
        let previewed = shown(sim, &intent).refusal;
        let ask = sim.intent(intent);
        assert_eq!(previewed, sim.refusal(ask));
        previewed
    };
    // A suspend holds the pane: busy, not «already closing».
    let mut sim = Sim::booted();
    sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(3) });
    assert_eq!(same(&mut sim, close_agent(3)), Some(Refusal::Busy));

    // A team of another workspace, named under this one: not found.
    let mut facts = deck();
    facts.workspaces.push(WorkspaceFacts {
        id: WorkspaceId("ws-b".into()),
        name: "other".into(),
        cwd: Dir::new("/other"),
        worktree_base: None,
        archived: false,
        archiving: false,
            repo: None,
        teams: vec![],
        panes: vec![],
    });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    let elsewhere = Intent::Disband { workspace: WorkspaceId("ws-b".into()), team: team("1"), consent: Consent::default() };
    assert_eq!(same(&mut sim, elsewhere), Some(Refusal::NotFound));

    // An archive under way: archived, for a second archive.
    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    assert_eq!(same(&mut sim, Intent::Archive { workspace: ws() }), Some(Refusal::Archived));
}

#[test]
fn a_seat_on_a_team_of_another_workspace_is_refused_as_not_found() {
    let mut sim = Sim::booted();
    let ask = sim.intent(Intent::Seat { workspace: WorkspaceId("elsewhere".into()), team: team("r"), member: draft() });
    assert_eq!(sim.refusal(ask), Some(Refusal::NotFound));
}

// ------------------------------------------------------- acceptance: races with Close

fn relocate_to_root(pane: u64) -> Intent {
    Intent::Relocate { workspace: ws(), pane: PaneId(pane), root: team("new-root"), role: None }
}

/// The close entry the machine writes, once it writes one.
fn close_entry_panes(sim: &Sim) -> Option<Vec<PaneId>> {
    sim.owed().into_iter().find_map(|effect| match effect {
        Effect::WriteJournal { entry, .. } => match entry.work {
            Work::Close { panes, .. } => Some(panes),
            _ => None,
        },
        _ => None,
    })
}

#[test]
fn a_close_waits_for_a_relocate_begun_before_it_and_takes_the_membership_its_answer_left() {
    let mut sim = Sim::booted();
    let moved = sim.intent(relocate_to_root(2));
    let close = sim.close(disband("1", Consent::default()));
    assert_eq!(sim.refusal(close), None);
    // The owner has not answered — it may be stopped: the close waits.
    assert_eq!(close_entry_panes(&sim), None, "no entry while the move is unanswered");
    // Applied is not enough: the membership counts once it is on disk.
    sim.apply(|cmd| matches!(cmd, Cmd::MovePane { .. }));
    assert!(matches!(sim.answer(moved), Some(Answer::Accepted { .. })));
    assert_eq!(close_entry_panes(&sim), None, "applied, not yet saved");
    sim.save();
    assert_eq!(close_entry_panes(&sim), Some(vec![PaneId(1)]), "the moved member left with its answer");
    sim.drive();
    assert_eq!(sim.state.world.panes[&PaneId(2)].team, Some(team("r")), "the moved member stays, on the root team");
    assert_eq!(sim.carried.iter().filter(|cmd| matches!(cmd, Cmd::MovePane { .. })).count(), 1, "the move is not sent again");
}

#[test]
fn a_relocate_onto_a_team_being_closed_is_refused() {
    let mut sim = Sim::booted();
    sim.close(disband("r", Consent::default()));
    let moved = sim.intent(relocate_to_root(2));
    assert_eq!(sim.refusal(moved), Some(Refusal::TargetLeaving));
    sim.drive();
    assert_eq!(sim.state.world.panes[&PaneId(2)].team, Some(team("1")), "it stays where it was");
}

#[test]
fn one_conversation_resumed_twice_is_taken_once() {
    let mut sim = Sim::booted();
    let resume = |sim: &mut Sim| {
        sim.intent(Intent::Continue {
            workspace: ws(),
            landing: Landing::Team { team: team("r") },
            source: SessionKey { agent: "claude".into(), session: "s9".into() },
            how: Continuation::Resume,
            member: draft(),
        })
    };
    let first = resume(&mut sim);
    let second = resume(&mut sim);
    assert_eq!(sim.refusal(first), None);
    assert_eq!(sim.refusal(second), Some(Refusal::Busy));
    sim.drive();
    assert_eq!(sim.carried.iter().filter(|cmd| matches!(cmd, Cmd::AddPane { .. })).count(), 1, "one pane holds it");
}

#[test]
fn a_write_from_a_disbanded_team_is_refused_while_its_workspace_lives() {
    let mut sim = Sim::booted();
    sim.close(disband("1", Consent::default()));
    sim.drive();
    let forgotten = |team_name: Option<&str>| sim.state.forgotten.source(&ws(), team_name.map(team).as_ref(), None);
    assert!(forgotten(Some("1")), "the disbanded team's artifact write");
    assert!(!forgotten(Some("r")), "the team that stays");
    assert!(!forgotten(None), "the workspace's own");
}

#[test]
fn a_disband_deletes_its_tasks_once_and_an_archive_keeps_them() {
    let mut sim = Sim::booted();
    sim.close(disband("1", Consent::default()));
    sim.drive();
    let deletes = sim.carried.iter().filter(|cmd| matches!(cmd, Cmd::DeleteTeamTasks { .. })).count();
    assert_eq!(deletes, 1);

    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    sim.drive();
    assert!(sim.carried.iter().all(|cmd| !matches!(cmd, Cmd::DeleteTeamTasks { .. } | Cmd::ForgetBoards { .. })), "{:?}", sim.carried);
}

#[test]
fn an_archive_takes_the_plantings_back_keeps_folders_and_layout_and_restore_brings_it_back() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    sim.drive();
    assert!(sim.cleaned.contains(&Clean::Disarm { dir: Dir::new("/wt/kd-app-1") }), "the plantings go, as today: {:?}", sim.cleaned);
    assert!(!sim.cleaned.iter().any(|clean| matches!(clean, Clean::Checkout { .. } | Clean::Branch { .. } | Clean::Stores { .. })));
    assert!(sim.carried.contains(&Cmd::MarkArchived { workspace: ws() }));
    assert!(!sim.carried.iter().any(|cmd| matches!(cmd, Cmd::RemovePane { .. } | Cmd::RemoveTeam { .. })), "the layout stays");
    assert_eq!(sim.state.world.panes.len(), 3);

    let restore = sim.intent(Intent::Restore { workspace: ws() });
    sim.drive();
    assert!(matches!(sim.answer(restore), Some(Answer::Accepted { .. })));
    assert!(sim.carried.contains(&Cmd::ClearArchived { workspace: ws() }));
    assert!(!sim.state.world.workspaces[&ws()].archived);
    assert_eq!(sim.state.world.members(&team("1")), vec![PaneId(1), PaneId(2)]);
}

/// An archive ends every process of the workspace, keeps every pane and
/// team where it stood, and lets go of each pane's slot.
#[test]
fn an_archive_stops_every_session_of_its_workspace_and_keeps_the_layout() {
    let mut sim = Sim::booted();
    let sessions: Vec<SessionId> =
        [(1, "/wt/kd-app-1"), (3, "/repo")].into_iter().map(|(pane, dir)| sim.appear(LaunchOwner::Pane { pane: PaneId(pane) }, None, Some(dir))).collect();
    let ask = sim.intent(Intent::Archive { workspace: ws() });
    sim.drive();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    for session in &sessions {
        assert!(sim.state.sessions[session].ended, "{session:?} stopped, and over");
    }
    assert!(sim.state.world.workspaces[&ws()].archived);
    assert_eq!(sim.state.world.panes.len(), 3, "every pane stays");
    assert_eq!(sim.state.world.members(&team("1")), vec![PaneId(1), PaneId(2)], "and every team");
    assert_eq!(released(&sim), vec![(PaneId(1), false), (PaneId(2), false), (PaneId(3), false)]);
}

/// Nothing is restarted, suspended or resumed in a workspace put away.
#[test]
fn a_pane_of_an_archived_workspace_is_not_restarted_suspended_or_resumed() {
    let mut sim = Sim::booted();
    sim.intent(Intent::Archive { workspace: ws() });
    sim.drive();
    for intent in [
        Intent::Restart { workspace: ws(), pane: PaneId(1) },
        Intent::Suspend { workspace: ws(), pane: PaneId(2) },
        Intent::Resume { workspace: ws(), pane: PaneId(1) },
    ] {
        let ask = sim.intent(intent.clone());
        assert_eq!(sim.refusal(ask), Some(Refusal::Archived), "{intent:?}");
    }
}

/// One exclusive operation on a workspace at a time, and only a Close takes
/// over a creation: an archive asked while a team is being created hears
/// «busy» — main's archive waited the creation out; the lifecycle design
/// chose this instead — and goes once the creation is done, putting away
/// what landed with the rest.
#[test]
fn an_archive_asked_while_a_team_is_being_created_hears_busy_and_goes_once_it_is_made() {
    let mut sim = Sim::booted();
    sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
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
    assert!(sim.owed().iter().any(|effect| matches!(effect, Effect::CreateWorktree { .. })), "git is out");
    let early = sim.intent(Intent::Archive { workspace: ws() });
    assert_eq!(sim.refusal(early), Some(Refusal::Busy));
    sim.drive();
    let archive = sim.intent(Intent::Archive { workspace: ws() });
    sim.drive();
    assert!(matches!(sim.answer(archive), Some(Answer::Accepted { .. })));
    assert!(sim.state.ops.is_empty(), "{:?}", sim.state.ops);
    assert!(sim.state.world.workspaces[&ws()].archived);
    assert!(sim.state.world.teams.contains_key(&team("n")), "what landed stays, put away with the rest");
}

/// A resume asked while the pane's suspend is still under way hears «busy»,
/// not «nothing to resume»: the pane is marked suspended only once it is
/// over. Once it is, the resume goes.
#[test]
fn a_resume_while_the_suspend_is_under_way_hears_busy_and_goes_once_it_is_over() {
    let mut sim = Sim::booted();
    sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
    sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(1) });
    let early = sim.intent(Intent::Resume { workspace: ws(), pane: PaneId(1) });
    assert_eq!(sim.refusal(early), Some(Refusal::Busy));
    sim.drive();
    let resume = sim.intent(Intent::Resume { workspace: ws(), pane: PaneId(1) });
    sim.drive();
    assert!(matches!(sim.answer(resume), Some(Answer::Accepted { .. })));
    assert!(!sim.state.world.panes[&PaneId(1)].suspended);
}

/// One operation on a workspace at a time: a restore asked while the archive
/// is under way hears «busy» — the workspace is marked archived only once it
/// is over, so it is not "nothing to restore" — and goes once it is.
#[test]
fn a_restore_while_the_archive_is_under_way_hears_busy_and_goes_once_it_is_over() {
    let mut sim = Sim::booted();
    sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
    sim.intent(Intent::Archive { workspace: ws() });
    sim.write_journals();
    let early = sim.intent(Intent::Restore { workspace: ws() });
    assert_eq!(sim.refusal(early), Some(Refusal::Busy));
    sim.drive();
    let restore = sim.intent(Intent::Restore { workspace: ws() });
    sim.drive();
    assert!(matches!(sim.answer(restore), Some(Answer::Accepted { .. })));
    assert!(!sim.state.world.workspaces[&ws()].archived);
}

/// A workspace a confirmed close is ending is not archived on its way out.
#[test]
fn an_archive_of_a_workspace_a_close_is_ending_hears_already_closing() {
    let mut sim = Sim::booted();
    sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    let archive = sim.intent(Intent::Archive { workspace: ws() });
    assert_eq!(sim.refusal(archive), Some(Refusal::AlreadyClosing));
}

/// A folder a team of ANOTHER workspace still works in is not offered: a
/// path is one place on disk, whoever's workspace it is.
#[test]
fn a_folder_a_team_of_another_workspace_works_in_is_not_offered() {
    let mut facts = deck();
    let (other, _) = beside_another_and_a_twin(&mut facts);
    let index = facts.workspaces.iter().position(|ws| ws.id == other).unwrap();
    facts.workspaces[index].teams.push(TeamFacts { id: team("b"), at: TeamAtFacts::Attached { cwd: Dir::new("/wt/kd-app-1"), branch: Some("kd/app/1".into()) } });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    assert!(shown(&sim, &disband("1", Consent::default())).folders.is_empty(), "team b keeps it");
}

/// A workspace that is gone has nothing to end and nothing to delete.
#[test]
fn a_gone_workspace_offers_nothing() {
    let sim = Sim::booted();
    let gone = WorkspaceId("ws-gone".into());
    let offer = shown(&sim, &Intent::CloseWorkspace { workspace: gone, consent: Consent::default() });
    assert!(offer.stops.is_empty() && offer.folders.is_empty());
}

/// The step results of a world where the cleanup steps `fails` names fail,
/// as a refusing git or a planting that would not go.
fn failing(fails: impl Fn(&Clean) -> bool) -> impl Fn(&Clean) -> StepResult {
    move |how| if fails(how) { Err("refused".into()) } else { Ok(()) }
}

/// Taking the plantings back comes first, but a failure there does not keep
/// the checkout: it is removed all the same, and the failed step stays owed.
#[test]
fn a_checkout_is_removed_even_when_taking_its_plantings_back_failed() {
    let mut sim = Sim::booted();
    sim.close(disband("1", consent_for_team_1()));
    sim.drive_with(&failing(|how| matches!(how, Clean::Disarm { .. })));
    assert!(!sim.cleaned.iter().any(|how| matches!(how, Clean::Disarm { .. })), "the planting stayed");
    assert!(sim.cleaned.contains(&Clean::Checkout { repo: Dir::new("/repo"), path: Dir::new("/wt/kd-app-1") }), "{:?}", sim.cleaned);
    let op = sim.state.ops.values().next().expect("owed, not done");
    assert!(op.owed, "the failed step is owed to the next launch");
}

/// A removal that fails holds its own operation for the next launch, and
/// nothing else: a later teardown elsewhere runs to its end.
#[test]
fn a_failed_removal_does_not_hold_up_another_teardown() {
    let mut sim = Sim::booted();
    sim.close(disband("1", consent_for_team_1()));
    sim.drive_with(&failing(|how| matches!(how, Clean::Checkout { .. })));
    assert_eq!(sim.state.ops.len(), 1, "the failed one waits");
    let suspend = sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(3) });
    sim.drive();
    assert!(matches!(sim.answer(suspend), Some(Answer::Accepted { .. })));
    assert_eq!(sim.state.ops.len(), 1, "the other one ended: {:?}", sim.state.ops);
    assert!(sim.state.world.panes[&PaneId(3)].suspended);
}

#[test]
fn a_close_without_consent_deletes_no_folder() {
    let mut sim = Sim::booted();
    let ask = sim.close(disband("1", Consent::default()));
    sim.drive();
    assert!(matches!(sim.answer(ask), Some(Answer::Accepted { .. })));
    assert!(
        !sim.cleaned.iter().any(|clean| matches!(clean, Clean::Checkout { .. } | Clean::Branch { .. })),
        "the folder and its branch stay: {:?}",
        sim.cleaned
    );
}

#[test]
fn a_creation_git_refused_is_failed_with_retry_and_the_retry_makes_it() {
    let mut sim = Sim::booted();
    sim.intent(Intent::CreateTeam { workspace: ws(), team: team("n"), site: Site::New { place: None, base: None }, draft: draft(), members: vec![] });
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
    let op = *sim.state.ops.keys().next().unwrap();
    sim.send(Event::Created { op, result: Err("a branch of that name exists".into()) });
    sim.drive();
    assert!(sim.carried.iter().any(|cmd| matches!(cmd, Cmd::FailTeam { .. })));
    assert!(!sim.carried.iter().any(|cmd| matches!(cmd, Cmd::SettleTeam { .. })), "no fallback to another folder: {:?}", sim.carried);
    assert_eq!(snapshot(&sim.state).teams[&team("n")], TeamPhase::Failed);
    assert_eq!(snapshot(&sim.state).gates[&team("n")].retry, None);
    let retry = sim.intent(Intent::Retry { workspace: ws(), team: team("n") });
    sim.drive();
    assert!(matches!(sim.answer(retry), Some(Answer::Accepted { .. })));
    assert_eq!(snapshot(&sim.state).teams[&team("n")], TeamPhase::Live);
}

#[test]
fn a_planting_lease_is_granted_on_a_live_folder_and_refused_on_one_a_close_holds() {
    let mut sim = Sim::booted();
    let arm = |sim: &mut Sim| {
        let ask = sim.next_ask();
        sim.send(Event::Lease { ask, lease: LeaseAsk::Arm { workspace: ws(), dir: Dir::new("/wt/kd-app-1") } });
        sim.answer(ask).expect("an answer")
    };
    assert!(matches!(arm(&mut sim), Answer::Leased { .. }));
    sim.close(disband("1", consent_for_team_1()));
    assert_eq!(arm(&mut sim), Answer::refused(Refusal::TargetLeaving));
}

#[test]
fn a_remote_pane_launches_with_no_folder_and_its_close_completes() {
    let mut facts = deck();
    facts.workspaces[0].panes.push(PaneFacts { id: PaneId(4), team: Some(team("r")), remote: true, suspended: false });
    let mut sim = Sim::booted_with(facts, Vec::new());
    sim.drive();
    let owner = LaunchOwner::Remote { pane: PaneId(4) };
    let ask = sim.next_ask();
    sim.send(Event::Lease { ask, lease: LeaseAsk::Launch { workspace: ws(), owner: owner.clone(), dir: None } });
    let Some(Answer::Leased { permit }) = sim.answer(ask) else { panic!("{:?}", sim.answer(ask)) };
    let ask = sim.next_ask();
    sim.send(Event::Admit { ask, permit, owner: owner.clone(), dir: None });
    assert!(matches!(sim.answer(ask), Some(Answer::Admitted { .. })));
    let close = sim.close(close_agent(4));
    sim.drive();
    assert!(matches!(sim.answer(close), Some(Answer::Accepted { .. })));
    assert!(!sim.state.world.panes.contains_key(&PaneId(4)));
}

/// The late plan of a disband: a fork begun before the disband lands its
/// pane — the close waits for it, as for a seat — and the close then takes
/// that pane: its plan is retired, its mail forgotten, and nothing of it
/// outlives the team.
#[test]
fn a_fork_whose_plan_lands_during_its_teams_disband_leaves_with_the_team() {
    let (mut sim, _ask, op) = forking();
    let close = sim.close(disband("r", Consent::default()));
    assert_eq!(sim.refusal(close), None);
    let forked = PaneId(4);
    assert!(shown(&sim, &disband("r", Consent::default())).stops.contains(&forked), "the dialog counted the pane still landing");
    // The plan lands late.
    sim.apply(|cmd| matches!(cmd, Cmd::Fork { .. }));
    sim.send(Event::HookEnded { op });
    sim.drive();
    assert!(matches!(sim.answer(close), Some(Answer::Accepted { .. })));
    let at = |wanted: &Cmd| sim.carried.iter().position(|cmd| cmd == wanted);
    let added = at(&Cmd::AddPane { workspace: ws(), team: team("r"), pane: forked, draft: draft() }).expect("the fork landed first");
    let retired = at(&Cmd::Retire { workspace: ws(), pane: forked }).expect("its plan is retired");
    assert!(added < retired);
    assert!(sim.carried.contains(&Cmd::ForgetPaneMail { workspace: ws(), pane: forked }));
    assert!(!sim.state.world.panes.contains_key(&forked) && !sim.state.world.teams.contains_key(&team("r")));
    assert!(sim.state.forgotten.panes.contains(&forked));
}

#[test]
fn a_suspend_during_a_disband_is_refused_and_the_disband_still_stops_the_pane() {
    let mut sim = Sim::booted();
    let session = sim.appear(LaunchOwner::Pane { pane: PaneId(1) }, None, Some("/wt/kd-app-1"));
    sim.close(disband("1", Consent::default()));
    let suspend = sim.intent(Intent::Suspend { workspace: ws(), pane: PaneId(1) });
    assert_eq!(sim.refusal(suspend), Some(Refusal::AlreadyClosing));
    for _ in 0..4 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    assert!(sim.owed().contains(&Effect::Stop { session }));
}

#[test]
fn a_run_launch_admitted_before_a_workspace_close_is_stopped_when_it_appears_and_none_is_leased_after() {
    let mut sim = Sim::booted();
    let owner = LaunchOwner::Plugin { plugin: "run".into(), workspace: ws() };
    let lease = |sim: &mut Sim| {
        let ask = sim.next_ask();
        sim.send(Event::Lease { ask, lease: LeaseAsk::Launch { workspace: ws(), owner: owner.clone(), dir: Some(Dir::new("/repo")) } });
        sim.answer(ask).expect("an answer")
    };
    let Answer::Leased { permit } = lease(&mut sim) else { panic!() };
    let ask = sim.next_ask();
    sim.send(Event::Admit { ask, permit, owner: owner.clone(), dir: Some(Dir::new("/repo")) });
    let Some(Answer::Admitted { attempt }) = sim.answer(ask) else { panic!() };
    sim.close(Intent::CloseWorkspace { workspace: ws(), consent: Consent::default() });
    for _ in 0..3 {
        sim.write_journals();
        sim.apply(|_| true);
        sim.save();
    }
    let op = *sim.state.ops.keys().next().unwrap();
    sim.send(Event::Cancelled { op, started: vec![attempt] });
    let session = sim.appear(owner.clone(), Some(attempt), Some("/repo"));
    assert!(sim.owed().contains(&Effect::Stop { session }), "the late Run is stopped");
    sim.drive();
    assert!(matches!(lease(&mut sim), Answer::Refused { .. }), "nothing launches in a closed workspace");
}

// ------------------------------------------------------- the wire, for TS

/// One of every refusal. A new kind fails to compile here until it has its
/// example — and so, through the TS contract test, its words.
fn every_refusal() -> Vec<Refusal> {
    let every = vec![
        Refusal::AlreadyClosing,
        Refusal::Busy,
        Refusal::NotFound,
        Refusal::BarrierUp,
        Refusal::JournalUnavailable,
        Refusal::JournalStuck,
        Refusal::LocationHeld,
        Refusal::TargetLeaving,
        Refusal::Archived,
        Refusal::SessionsDown,
        Refusal::ForkStepExpired,
        Refusal::ForkUnfinished,
        Refusal::Changed,
        Refusal::Rejected { why: Why(json!({ "kind": "role", "why": "taken", "role": "lead" })) },
    ];
    for refusal in &every {
        match refusal {
            Refusal::AlreadyClosing
            | Refusal::Busy
            | Refusal::NotFound
            | Refusal::BarrierUp
            | Refusal::JournalUnavailable
            | Refusal::JournalStuck
            | Refusal::LocationHeld
            | Refusal::TargetLeaving
            | Refusal::Archived
            | Refusal::SessionsDown
            | Refusal::ForkStepExpired
            | Refusal::ForkUnfinished
            | Refusal::Changed
            | Refusal::Rejected { .. } => {}
        }
    }
    every
}

/// One of every command, each under its owner.
fn every_due() -> Vec<Due> {
    let w = ws;
    let p = PaneId;
    let every = vec![
        Cmd::AddWorkspace { workspace: w(), draft: draft() },
        Cmd::AddTeam {
            workspace: w(),
            team: team("n"),
            draft: draft(),
            place: crate::command::TeamPlace::Attached { cwd: Dir::new("/repo"), branch: None },
            members: vec![crate::command::Member { pane: p(4), draft: draft() }],
        },
        Cmd::RetryTeam { workspace: w(), team: team("n") },
        Cmd::SettleTeam { workspace: w(), team: team("n"), cwd: Dir::new("/wt/kd-app-2"), branch: Some("kd/app/2".into()) },
        Cmd::FailTeam { workspace: w(), team: team("n"), reason: "no space".into() },
        Cmd::AddPane { workspace: w(), team: team("1"), pane: p(5), draft: draft() },
        Cmd::MovePane { workspace: w(), pane: p(5), to: team("r"), new_root: false, role: Some("reviewer".into()) },
        Cmd::RemovePane { workspace: w(), pane: p(5) },
        Cmd::RemoveTeam { workspace: w(), team: team("n") },
        Cmd::RemoveWorkspace { workspace: w() },
        Cmd::MarkArchived { workspace: w() },
        Cmd::ClearArchived { workspace: w() },
        Cmd::MarkSuspended { workspace: w(), pane: p(1) },
        Cmd::ClearSuspended { workspace: w(), pane: p(1) },
        Cmd::DeleteTeamTasks { workspace: w(), team: team("n") },
        Cmd::ForgetBoards { workspace: w() },
        Cmd::RetainTeams { teams: vec![team("1"), team("r")] },
        Cmd::ForgetPaneMail { workspace: w(), pane: p(5) },
        Cmd::RetainPanes { panes: vec![p(1), p(2)] },
        Cmd::Retire { workspace: w(), pane: p(2) },
        Cmd::Release { workspace: w(), pane: p(2), in_place: true },
        Cmd::PrepareResume { workspace: w(), pane: p(2), source: SessionKey { agent: "cli-a".into(), session: "s-1".into() } },
        Cmd::DropBuild { op: OpId(3) },
        Cmd::ReportBinding { workspace: w(), pane: p(6), op: OpId(3) },
        Cmd::WorktreeNotDeleted { workspace: w(), path: Dir::new("/wt/kd-app-1"), reason: "busy".into() },
        Cmd::Fork { workspace: w(), pane: p(1), source: SessionKey { agent: "cli-a".into(), session: "s-1".into() }, cwd: Dir::new("/repo") },
    ];
    for cmd in &every {
        match cmd {
            Cmd::AddWorkspace { .. }
            | Cmd::AddTeam { .. }
            | Cmd::RetryTeam { .. }
            | Cmd::SettleTeam { .. }
            | Cmd::FailTeam { .. }
            | Cmd::AddPane { .. }
            | Cmd::MovePane { .. }
            | Cmd::RemovePane { .. }
            | Cmd::RemoveTeam { .. }
            | Cmd::RemoveWorkspace { .. }
            | Cmd::MarkArchived { .. }
            | Cmd::ClearArchived { .. }
            | Cmd::MarkSuspended { .. }
            | Cmd::ClearSuspended { .. }
            | Cmd::DeleteTeamTasks { .. }
            | Cmd::ForgetBoards { .. }
            | Cmd::RetainTeams { .. }
            | Cmd::ForgetPaneMail { .. }
            | Cmd::RetainPanes { .. }
            | Cmd::Retire { .. }
            | Cmd::Release { .. }
            | Cmd::PrepareResume { .. }
            | Cmd::DropBuild { .. }
            | Cmd::ReportBinding { .. }
            | Cmd::WorktreeNotDeleted { .. }
            | Cmd::Fork { .. } => {}
        }
    }
    every
        .into_iter()
        .enumerate()
        .map(|(index, cmd)| Due { id: crate::ids::CommandId { op: OpId(1), index: index as u32 }, owner: cmd.owner(), cmd })
        .collect()
}

/// What Rust sends TS, one of every kind, written beside the exported types
/// as a typed module: TS compiles each example against its type, and the
/// contract tests handle each as it arrives here.
#[test]
fn the_wire_examples_are_written_beside_the_exported_types() {
    let mut sim = Sim::booted();
    sim.intent(close_agent(2));
    sim.round();
    let versioned = super::snapshot::Versioned { version: 7, snapshot: snapshot(&sim.state) };
    assert!(!versioned.snapshot.commands.is_empty(), "the example carries commands owed");
    let answers = vec![
        Answer::Accepted { op: OpId(9), minted: model::Minted { workspace: None, team: Some(team("n")), panes: vec![PaneId(4)] } },
        Answer::Leased { permit: crate::ids::PermitId(2) },
        Answer::Admitted { attempt: crate::ids::AttemptId(3) },
        Answer::Booted { finishing: vec![OpId(1)] },
    ];
    let mut replies: Vec<model::Reply> = answers.into_iter().map(|answer| model::Reply::Answered { answer }).collect();
    replies.extend(every_refusal().into_iter().map(|refusal| model::Reply::Answered { answer: Answer::Refused { refusal } }));
    replies.push(model::Reply::Unavailable);
    replies.push(model::Reply::Unknown);
    let outcomes = vec![
        Outcome::Applied { revision: Some(Revision(4)) },
        Outcome::Unchanged { revision: None },
        Outcome::Rejected { why: Why(json!({ "kind": "role", "why": "taken", "role": "lead" })) },
        Outcome::Forked { discard: Discard { plugin: "keepdeck.cli-a".into(), once_started: vec!["/kd/spec.json".into()], if_never_started: vec!["/store/fork.jsonl".into()] } },
    ];
    // Rust's own verdicts on sources against a forgotten set — the page's
    // one accessor must agree with each.
    let forgotten = Forgotten {
        workspaces: [WorkspaceId("ws-gone".into())].into(),
        teams: [team("gone")].into(),
        panes: [PaneId(9)].into(),
    };
    let sources = [
        ("ws-gone", None, None),
        ("ws-a", Some("team-gone"), None),
        ("ws-a", Some("team-1"), Some("pane-9")),
        ("ws-a", Some("team-1"), Some("pane-1")),
        ("ws-a", None, Some("pane-1")),
        ("ws-a", None, None),
    ];
    let verdicts: Vec<serde_json::Value> = sources
        .iter()
        .map(|&(workspace, team_id, pane)| {
            let team_id = team_id.map(|t| TeamId(t.into()));
            let pane_id = pane.and_then(PaneId::parse);
            let verdict = forgotten.source(&WorkspaceId(workspace.into()), team_id.as_ref(), pane_id.as_ref());
            json!({ "source": { "workspaceId": workspace, "team": team_id.map(|t| t.0), "pane": pane }, "forgotten": verdict })
        })
        .collect();
    let typed = |name: &str, ty: &str, value: serde_json::Value| {
        format!("export const {name}: {ty} = {};\n", serde_json::to_string_pretty(&value).unwrap())
    };
    let text = [
        "// Written by the lifecycle crate's test `the_wire_examples_are_written_beside_the_exported_types`. Do not edit.\n".to_string(),
        "import type { Due } from \"./Due\";\nimport type { Forgotten } from \"./Forgotten\";\nimport type { Outcome } from \"./Outcome\";\nimport type { Refusal } from \"./Refusal\";\nimport type { Reply } from \"./Reply\";\nimport type { Versioned } from \"./Versioned\";\n".to_string(),
        typed("forgotten", "Forgotten", json!(forgotten)),
        typed(
            "verdicts",
            "{ source: { workspaceId: string; team: string | null; pane: string | null }; forgotten: boolean }[]",
            json!(verdicts),
        ),
        typed("refusals", "Refusal[]", json!(every_refusal())),
        typed("replies", "Reply[]", json!(replies)),
        typed("outcomes", "Outcome[]", json!(outcomes)),
        typed("dues", "Due[]", json!(every_due())),
        typed("versioned", "Versioned", json!(versioned)),
    ]
    .join("\n");
    let dir = std::path::PathBuf::from(std::env::var("TS_RS_EXPORT_DIR").expect("set by .cargo/config.toml")).join("lifecycle");
    let file = dir.join("examples.ts");
    if std::fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, text).unwrap();
    }
}
