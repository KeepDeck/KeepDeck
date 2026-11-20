//! The lifecycle machine as a whole, driven by random events with every door
//! simulated — the architect's probe of task-876, kept in the crate.
//!
//! What it holds:
//! - no sequence of events panics `update` or `work`: a panic there ends the
//!   machine's task, and with it every launch and every close until a restart;
//! - «forgotten» only grows; a pane number is never minted twice in one life;
//!   no ask is answered twice; the machine always settles;
//! - with every door answering, every operation ends or is owed: nothing is
//!   left that neither runs nor ends.
//!
//! And the two runs that broke it at 8dadfee7, as scenarios: an operation must
//! not outlive its workspace.

use keepdeck_fsm::Work as Owe;
use keepdeck_lifecycle::command::{Cmd, Outcome, Owner, Revision, Why};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{AskId, AttemptId, CommandId, OpId, PaneId, PermitId, SessionId, TeamId, WorkspaceId};
use keepdeck_lifecycle::journal::{Discard, Step};
use keepdeck_lifecycle::machine::queries::close_workspace_offer;
use keepdeck_lifecycle::machine::snapshot::snapshot;
use keepdeck_lifecycle::machine::{update, work, Effect, Event, Kind, LaunchOwner, LeaseAsk, Load, State, TearPhase, Timer};
use keepdeck_lifecycle::model::{Answer, Consent, Continuation, Draft, Intent, Landing, Place, Refusal, SessionKey, Site};
use keepdeck_lifecycle::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};
use std::cell::RefCell;
use std::collections::{BTreeSet, VecDeque};

thread_local! {
    /// The events of the run under way on this thread, for the report of a
    /// panic.
    static TRACE: RefCell<Vec<Event>> = const { RefCell::new(Vec::new()) };
}

/// A small deterministic generator: a failing seed is replayed exactly.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Clone>(&mut self, of: &[T]) -> T {
        of[self.below(of.len() as u64) as usize].clone()
    }
}

fn ws(n: u64) -> WorkspaceId {
    WorkspaceId(format!("ws-{n}"))
}

fn team(n: u64) -> TeamId {
    TeamId(format!("team-{n}"))
}

fn dir(text: &str) -> Dir {
    Dir::new(text)
}

fn draft() -> Draft {
    Draft(serde_json::json!({"name": "x", "agentType": "claude", "role": "member"}))
}

fn forked() -> Outcome {
    Outcome::Forked { discard: Discard { plugin: "claude".into(), once_started: vec!["/s/tmp".into()], if_never_started: vec!["/s/copy".into()] } }
}

/// How the doors behave in one run.
#[derive(Clone, Copy, Debug)]
struct Doors {
    /// Percent of work that fails.
    fail: u64,
    /// Percent of owner answers that reject.
    reject: u64,
    /// Percent of made-up or stale events mixed in.
    garbage: u64,
}

const QUIET: Doors = Doors { fail: 0, reject: 0, garbage: 0 };
const NOISY: Doors = Doors { fail: 15, reject: 15, garbage: 60 };

/// The machine and everything around it: the handler, the owners in TS, the
/// spawn door and the sessions machine, each simulated.
struct World {
    state: State,
    rng: Rng,
    doors: Doors,
    asks: u64,
    answered: BTreeSet<AskId>,
    refused: Vec<(AskId, Refusal)>,
    /// Results of work on their way back.
    mail: VecDeque<Event>,
    /// Work already handed over: the runtime starts an owed piece once.
    running: Vec<Owe<Effect, Event>>,
    timers: Vec<Event>,
    minted: BTreeSet<PaneId>,
    permits: Vec<PermitId>,
    attempts: Vec<(AttemptId, LaunchOwner, Option<Dir>)>,
    sessions: u64,
    live: Vec<SessionId>,
    answered_cmds: BTreeSet<CommandId>,
    revision: u64,
    teams: Vec<TeamId>,
    /// Operations whose commands the owners do not answer yet.
    hold: BTreeSet<OpId>,
    /// The fork step's hook is slow: its command is not answered yet.
    slow_hook: bool,
    /// The deck's save is on its way: no saved revision is reported yet.
    save_in_flight: bool,
}

impl World {
    fn new(seed: u64, doors: Doors) -> World {
        TRACE.with(|trace| trace.borrow_mut().clear());
        World {
            state: State::start(Some(Vec::new())),
            rng: Rng(seed | 1),
            doors,
            asks: 0,
            answered: BTreeSet::new(),
            refused: Vec::new(),
            mail: VecDeque::new(),
            running: Vec::new(),
            timers: Vec::new(),
            minted: BTreeSet::new(),
            permits: Vec::new(),
            attempts: Vec::new(),
            sessions: 0,
            live: Vec::new(),
            answered_cmds: BTreeSet::new(),
            revision: 0,
            teams: vec![team(1), team(2)],
            hold: BTreeSet::new(),
            slow_hook: false,
            save_in_flight: false,
        }
    }

    fn ask(&mut self) -> AskId {
        self.asks += 1;
        AskId(self.asks)
    }

    /// One event through the machine, its invariants checked, the work the
    /// new state owes started as the runtime starts it.
    fn send(&mut self, event: Event) {
        TRACE.with(|trace| trace.borrow_mut().push(event.clone()));
        let before = self.state.clone();
        let next = update(&self.state, event);
        if let Some(state) = next.state {
            self.state = state;
        }
        for effect in next.effects {
            self.effect(effect);
        }
        let (was, is) = (&before.forgotten, &self.state.forgotten);
        assert!(was.workspaces.is_subset(&is.workspaces) && was.teams.is_subset(&is.teams) && was.panes.is_subset(&is.panes), "«forgotten» shrank");
        let owed: Vec<Owe<Effect, Event>> = work(&self.state).into_iter().collect();
        self.running.retain(|running| owed.contains(running));
        for piece in owed {
            if self.running.contains(&piece) {
                continue;
            }
            match &piece {
                Owe::Run(effect) => self.effect(effect.clone()),
                Owe::After(_, event) => self.timers.push(event.clone()),
            }
            self.running.push(piece);
        }
        let still: Vec<Event> = self.running.iter().filter_map(|piece| if let Owe::After(_, event) = piece { Some(event.clone()) } else { None }).collect();
        self.timers.retain(|timer| still.contains(timer));
    }

    fn effect(&mut self, effect: Effect) {
        let fail = self.rng.chance(self.doors.fail);
        let result = |fail: bool| if fail { Err("no".to_string()) } else { Ok(()) };
        match effect {
            Effect::Answer { ask, answer } => {
                assert!(self.answered.insert(ask), "ask {ask:?} was answered twice");
                match answer {
                    Answer::Accepted { minted, .. } => {
                        for pane in minted.panes {
                            assert!(self.minted.insert(pane), "pane {pane} was minted twice in one life");
                        }
                    }
                    Answer::Leased { permit } => self.permits.push(permit),
                    Answer::Refused { refusal } => self.refused.push((ask, refusal)),
                    _ => {}
                }
            }
            Effect::WriteJournal { op, attempt, .. } => self.mail.push_back(Event::JournalWritten { op, attempt, result: result(fail) }),
            Effect::RemoveJournal { op, attempt } => self.mail.push_back(Event::JournalRemoved { op, attempt, result: result(fail) }),
            Effect::Probe { op, path, .. } => {
                let taken = self.rng.chance(20);
                self.mail.push_back(Event::Probed { op, path, taken });
            }
            Effect::CreateWorktree { op, .. } => self.mail.push_back(Event::Created { op, result: result(fail) }),
            Effect::FindWorktree { op, .. } => {
                let found = if fail { Err("unreadable".to_string()) } else { Ok(self.rng.chance(50)) };
                self.mail.push_back(Event::Found { op, found });
            }
            Effect::ReadBranches { op, path, .. } => {
                let result = if fail { Err("no".to_string()) } else { Ok(vec!["kd/x/1".to_string()]) };
                self.mail.push_back(Event::BranchesRead { op, path, result });
            }
            Effect::Clean { op, step, .. } => self.mail.push_back(Event::StepDone { op, step, result: result(fail) }),
            Effect::Stop { session } => {
                if self.live.contains(&session) {
                    self.live.retain(|live| *live != session);
                    self.mail.push_back(Event::SessionEnded { session });
                }
            }
            Effect::Cancel { op, attempts } => {
                // Those whose process exists are awaited; the others never start.
                let mut started = Vec::new();
                for attempt in attempts {
                    let Some(at) = self.attempts.iter().position(|(taken, _, _)| *taken == attempt) else { continue };
                    let (_, owner, dir) = self.attempts.remove(at);
                    if self.rng.chance(50) {
                        started.push(attempt);
                        if self.rng.chance(80) {
                            self.sessions += 1;
                            let session = SessionId(self.sessions);
                            self.live.push(session);
                            self.mail.push_back(Event::SessionAppeared { session, attempt: Some(attempt), owner, dir });
                        }
                    }
                }
                self.mail.push_back(Event::Cancelled { op, started });
            }
            Effect::Warn { message } => assert!(!message.contains("did not settle"), "the machine did not settle"),
        }
    }

    /// The owners in TS: each command due is answered once, some of them now.
    fn owners(&mut self) {
        for command in snapshot(&self.state).commands {
            if self.answered_cmds.contains(&command.id) || !self.rng.chance(70) {
                continue;
            }
            self.answered_cmds.insert(command.id);
            let outcome = if self.rng.chance(self.doors.reject) {
                Outcome::Rejected { why: Why(serde_json::json!({ "kind": "notTaken", "what": "agent" })) }
            } else {
                self.applied(&command.cmd, command.owner)
            };
            if let Cmd::Fork { .. } = command.cmd {
                self.mail.push_back(Event::HookEnded { op: command.id.op });
            }
            self.mail.push_back(Event::Answered { id: command.id, outcome });
        }
        if self.rng.chance(60) && self.revision > 0 {
            self.mail.push_back(Event::DeckSaved { revision: Revision(self.revision) });
        }
    }

    /// What an owner that carries a command out answers.
    fn applied(&mut self, cmd: &Cmd, owner: Owner) -> Outcome {
        match (cmd, owner) {
            (Cmd::Fork { .. }, _) => forked(),
            (_, Owner::Deck) => {
                self.revision += 1;
                Outcome::Applied { revision: Some(Revision(self.revision)) }
            }
            _ => Outcome::Applied { revision: None },
        }
    }

    fn any_pane(&mut self) -> PaneId {
        let known: Vec<PaneId> = self.state.world.panes.keys().copied().collect();
        if known.is_empty() || self.rng.chance(10) {
            PaneId(self.rng.below(12) + 1)
        } else {
            self.rng.pick(&known)
        }
    }

    fn consent(&mut self) -> Consent {
        let panes: Vec<PaneId> = self.state.world.panes.keys().copied().collect();
        let stops = panes.into_iter().filter(|_| self.rng.chance(80)).collect();
        let tickets = if self.rng.chance(50) { self.state.ops.keys().copied().collect() } else { Vec::new() };
        Consent { stops, tickets, ..Consent::default() }
    }

    fn fresh_team(&mut self) -> TeamId {
        let fresh = team(self.rng.below(9) + 1);
        if !self.teams.contains(&fresh) {
            self.teams.push(fresh.clone());
        }
        fresh
    }

    fn intent(&mut self) -> Intent {
        let workspace = self.rng.pick(&[ws(1), ws(2)]);
        let t = self.rng.pick(&self.teams.clone());
        let site = match self.rng.below(4) {
            0 => Site::Root,
            1 => Site::Existing { cwd: dir("/repo/wt/shared") },
            2 => Site::New { place: None, base: None },
            _ => Site::New { place: Some(Place { path: dir(&format!("/repo/wt/hand-{}", self.rng.below(3))), branch: format!("hand/{}", self.rng.below(3)) }), base: None },
        };
        let source = SessionKey { agent: "claude".into(), session: format!("s{}", self.rng.below(3)) };
        match self.rng.below(16) {
            0 => Intent::CreateWorkspace { workspace, name: "w".into(), cwd: dir("/repo"), worktree_base: Some(dir("/repo/wt")), draft: draft(), repo: Some(dir("/repo/.git")) },
            1 | 2 => Intent::CreateTeam { workspace, team: self.fresh_team(), site, draft: draft(), members: vec![draft(); self.rng.below(3) as usize] },
            3 => Intent::Retry { workspace, team: t },
            4 | 5 => Intent::Seat { workspace, team: t, member: draft() },
            6 => {
                let how = if self.rng.chance(50) { Continuation::Fork } else { Continuation::Resume };
                let landing = if self.rng.chance(50) { Landing::Team { team: t } } else { Landing::NewTeam { team: self.fresh_team(), site, draft: draft() } };
                Intent::Continue { workspace, landing, source, how, member: draft() }
            }
            7 => Intent::Relocate { workspace, pane: self.any_pane(), root: team(9), role: None },
            8 => Intent::CloseAgent { workspace, pane: self.any_pane(), consent: self.consent() },
            9 => Intent::Disband { workspace, team: t, consent: self.consent() },
            10 => Intent::CloseWorkspace { workspace, consent: self.consent() },
            11 => Intent::Archive { workspace },
            12 => Intent::Restore { workspace },
            13 => Intent::Restart { workspace, pane: self.any_pane() },
            14 => Intent::RemoveUnheld { workspace, path: dir("/repo/wt/orphan"), tag: None },
            _ if self.rng.chance(50) => Intent::Suspend { workspace, pane: self.any_pane() },
            _ => Intent::Resume { workspace, pane: self.any_pane() },
        }
    }

    /// An event no door would send now: a stale or made-up result.
    fn garbage(&mut self) -> Event {
        let op = OpId(self.rng.below(self.state.next.op.next().0 + 2));
        let path = dir(&format!("/repo/wt/hand-{}", self.rng.below(3)));
        match self.rng.below(14) {
            0 => Event::JournalWritten { op, attempt: self.rng.below(4) as u32, result: Ok(()) },
            1 => Event::JournalRemoved { op, attempt: self.rng.below(4) as u32, result: Ok(()) },
            2 => Event::Probed { op, path, taken: self.rng.chance(50) },
            3 => Event::Created { op, result: if self.rng.chance(50) { Ok(()) } else { Err("x".into()) } },
            4 => Event::Found { op, found: Ok(self.rng.chance(50)) },
            5 => Event::BranchesRead { op, path, result: Ok(vec![]) },
            6 => Event::StepDone { op, step: Step::Stores, result: Ok(()) },
            7 => Event::StepDone { op, step: Step::Checkout { path }, result: Err("x".into()) },
            8 => Event::Cancelled { op, started: vec![AttemptId(self.rng.below(5))] },
            9 => Event::HookEnded { op },
            10 => Event::Answered { id: CommandId { op, index: self.rng.below(4) as u32 }, outcome: Outcome::Applied { revision: None } },
            11 => Event::SessionEnded { session: SessionId(self.rng.below(self.sessions + 2)) },
            12 => Event::NotStarted { attempt: AttemptId(self.rng.below(6)) },
            _ => Event::Timer(match self.rng.below(5) {
                0 => Timer::Retire { op },
                1 => Timer::Leases { op },
                2 => Timer::Registration { op },
                3 => Timer::Permit { permit: PermitId(self.rng.below(6)) },
                _ => Timer::Fork { op },
            }),
        }
    }

    /// The spawn door and the sessions machine: leases, admissions, launches
    /// that start or do not, sessions that end.
    fn launch(&mut self) {
        let workspace = self.rng.pick(&[ws(1), ws(2)]);
        let pane = self.any_pane();
        let owner = match self.rng.below(3) {
            0 => LaunchOwner::Plugin { plugin: "run".into(), workspace: workspace.clone() },
            1 => LaunchOwner::Remote { pane },
            _ => LaunchOwner::Pane { pane },
        };
        let at = match owner {
            LaunchOwner::Remote { .. } => None,
            _ => Some(dir(self.rng.pick(&["/repo", "/repo/wt/shared", "/repo/wt/w-1"]))),
        };
        if self.rng.chance(30) {
            let ask = self.ask();
            let lease = if self.rng.chance(20) { LeaseAsk::Arm { workspace, dir: dir("/repo/wt/w-1") } } else { LeaseAsk::Launch { workspace, owner: owner.clone(), dir: at.clone() } };
            self.send(Event::Lease { ask, lease });
        }
        if let Some(permit) = self.permits.pop() {
            if self.rng.chance(25) {
                self.send(Event::Release { permit });
            } else {
                let ask = self.ask();
                let before = self.answered.len();
                let owner = self.state.permits.get(&permit).and_then(|leased| leased.owner.clone()).unwrap_or(owner);
                let at = self.state.permits.get(&permit).and_then(|leased| leased.dir.clone()).or(at);
                let admitted: BTreeSet<AttemptId> = self.state.attempts.keys().copied().collect();
                self.send(Event::Admit { ask, permit, owner: owner.clone(), dir: at.clone() });
                assert_eq!(self.answered.len(), before + 1, "an admission is answered at once");
                let new: Vec<AttemptId> = self.state.attempts.keys().copied().filter(|attempt| !admitted.contains(attempt)).collect();
                for attempt in new {
                    match self.rng.below(4) {
                        0 => self.send(Event::NotStarted { attempt }),
                        1 => self.attempts.push((attempt, owner.clone(), at.clone())),
                        _ => {
                            self.sessions += 1;
                            let session = SessionId(self.sessions);
                            self.live.push(session);
                            self.send(Event::SessionAppeared { session, attempt: Some(attempt), owner: owner.clone(), dir: at.clone() });
                        }
                    }
                }
            }
        }
        if self.rng.chance(10) {
            if let Some(session) = self.live.pop() {
                self.mail.push_back(Event::SessionEnded { session });
            }
        }
    }

    fn deliver(&mut self) {
        if let Some(event) = self.mail.pop_front() {
            self.send(event);
        }
    }

    fn fire(&mut self) {
        if self.timers.is_empty() {
            return;
        }
        let at = self.rng.below(self.timers.len() as u64) as usize;
        let event = self.timers.remove(at);
        self.running.retain(|piece| !matches!(piece, Owe::After(_, timer) if *timer == event));
        self.send(event);
    }

    /// Every door answers, in order, until nothing moves: results delivered,
    /// commands answered — but those of held operations and a slow hook's —
    /// and the deck saved unless its save is on its way. No timer fires.
    fn quiesce(&mut self) {
        for _ in 0..500 {
            let mut moved = false;
            while let Some(event) = self.mail.pop_front() {
                self.send(event);
                moved = true;
            }
            for command in snapshot(&self.state).commands {
                let hook = matches!(command.cmd, Cmd::Fork { .. });
                if self.hold.contains(&command.id.op) || (hook && self.slow_hook) || !self.answered_cmds.insert(command.id) {
                    continue;
                }
                let outcome = self.applied(&command.cmd, command.owner);
                if hook {
                    self.send(Event::HookEnded { op: command.id.op });
                }
                self.send(Event::Answered { id: command.id, outcome });
                if !self.save_in_flight {
                    self.send(Event::DeckSaved { revision: Revision(self.revision) });
                }
                moved = true;
            }
            if !moved {
                return;
            }
        }
        panic!("the doors never came to rest");
    }

    /// The waits of the operations run out, all but a fork's own deadline,
    /// each followed by the doors at rest.
    fn wait_out(&mut self) {
        for _ in 0..8 {
            let due: Vec<Event> = self.timers.iter().filter(|timer| !matches!(timer, Event::Timer(Timer::Fork { .. }))).cloned().collect();
            for timer in due {
                self.timers.retain(|waiting| *waiting != timer);
                self.running.retain(|piece| !matches!(piece, Owe::After(_, event) if *event == timer));
                self.send(timer);
                self.quiesce();
            }
        }
    }

    fn intent_now(&mut self, intent: Intent) -> AskId {
        let ask = self.ask();
        self.send(Event::Intent { ask, intent });
        ask
    }

    fn refusal(&self, ask: AskId) -> Option<Refusal> {
        self.refused.iter().find(|(refused, _)| *refused == ask).map(|(_, refusal)| refusal.clone())
    }
}

fn facts(rng: &mut Rng) -> DeckFacts {
    let panes = (1..=4u64)
        .map(|n| PaneFacts { id: PaneId(n), team: if n < 4 { Some(team(1 + n % 2)) } else { None }, remote: n == 3, suspended: rng.chance(20) })
        .collect();
    let second = if rng.chance(30) { TeamAtFacts::Provisioning { path: dir("/repo/wt/w-2"), branch: None } } else { TeamAtFacts::Unplaced };
    DeckFacts {
        workspaces: vec![WorkspaceFacts {
            id: ws(1),
            name: "w".into(),
            cwd: dir("/repo"),
            worktree_base: Some(dir("/repo/wt")),
            archived: false,
            archiving: rng.chance(10),
            teams: vec![
                TeamFacts { id: team(1), at: TeamAtFacts::Attached { cwd: dir("/repo/wt/w-1"), branch: Some("kd/w/1".into()) } },
                TeamFacts { id: team(2), at: second },
            ],
            panes,
            repo: Some(dir("/repo/.git")),
        }],
    }
}

/// One random run: asks, launches, results, owner answers, timers and
/// made-up events, mixed by the seed.
fn run(seed: u64, doors: Doors, load: Load, steps: u32) -> World {
    let mut world = World::new(seed, doors);
    let deck = facts(&mut world.rng);
    let ask = world.ask();
    world.send(Event::Handshake { ask, deck, load });
    for _ in 0..steps {
        match world.rng.below(100) {
            0..=24 => {
                let intent = world.intent();
                world.intent_now(intent);
            }
            25..=39 => world.launch(),
            40..=64 => world.deliver(),
            65..=79 => world.owners(),
            80..=86 => world.fire(),
            _ if world.rng.chance(world.doors.garbage) => {
                let event = world.garbage();
                world.send(event);
            }
            _ => world.deliver(),
        }
    }
    world
}

/// A run whose panic names its seed and how far it got.
fn guarded(seed: u64, doors: Doors, load: Load, steps: u32) -> World {
    match std::panic::catch_unwind(|| run(seed, doors, load, steps)) {
        Ok(world) => world,
        Err(panic) => {
            let why = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string())).unwrap_or_default();
            let events = TRACE.with(|trace| trace.borrow().len());
            panic!("seed {seed} ({doors:?}, {load:?}) after {events} events: {why}");
        }
    }
}

const SEEDS: u64 = 600;

#[test]
fn no_sequence_of_events_panics_the_machine_and_its_invariants_hold() {
    for seed in 1..=SEEDS {
        let load = if seed % 5 == 0 { Load::Quarantined } else { Load::Loaded };
        guarded(seed, NOISY, load, 400);
    }
}

#[test]
fn with_every_door_answering_every_operation_ends_or_is_owed() {
    let mut stuck = Vec::new();
    for seed in 1..=SEEDS {
        let mut world = guarded(seed, QUIET, Load::Loaded, 250);
        // No more asks: results, owners, saves and timers, until nothing moves.
        for _ in 0..4_000 {
            world.deliver();
            world.owners();
            if world.revision > 0 {
                world.send(Event::DeckSaved { revision: Revision(world.revision) });
            }
            // A session ends behind whatever is on its way: never before it appeared.
            if let Some(session) = world.live.pop() {
                world.mail.push_back(Event::SessionEnded { session });
            }
            for (attempt, _, _) in std::mem::take(&mut world.attempts) {
                world.send(Event::NotStarted { attempt });
            }
            let all_answered = snapshot(&world.state).commands.iter().all(|command| world.answered_cmds.contains(&command.id));
            if world.mail.is_empty() && all_answered {
                world.fire();
                if world.mail.is_empty() && world.timers.is_empty() {
                    break;
                }
            }
        }
        let left: Vec<String> = world.state.ops.iter().filter(|(_, op)| !op.owed).map(|(id, op)| format!("{id} {:?}", op.kind).chars().take(120).collect()).collect();
        if !left.is_empty() {
            stuck.push((seed, left));
        }
    }
    assert!(stuck.is_empty(), "{} of {SEEDS} runs left an operation that neither ended nor is owed; first: {:?}", stuck.len(), stuck.first());
}

/// One workspace, one team on its own worktree, one pane in it.
fn booted() -> World {
    let mut world = World::new(7, QUIET);
    let deck = DeckFacts {
        workspaces: vec![WorkspaceFacts {
            id: ws(1),
            name: "w".into(),
            cwd: dir("/repo"),
            worktree_base: Some(dir("/repo/wt")),
            archived: false,
            archiving: false,
            teams: vec![TeamFacts { id: team(1), at: TeamAtFacts::Attached { cwd: dir("/repo/wt/w-1"), branch: Some("kd/w/1".into()) } }],
            panes: vec![PaneFacts { id: PaneId(1), team: Some(team(1)), remote: false, suspended: false }],
            repo: Some(dir("/repo/.git")),
        }],
    };
    let ask = world.ask();
    world.send(Event::Handshake { ask, deck, load: Load::Loaded });
    world.quiesce();
    world
}

fn close_phase(world: &World) -> Option<TearPhase> {
    world.state.ops.values().find_map(|op| match &op.kind {
        Kind::Teardown(teardown) => Some(teardown.phase),
        _ => None,
    })
}

/// A fork into a new team at the workspace's root, its team published to
/// the deck and the page's answer one round trip away, when the workspace's
/// close arrives. The close waits for the fork — it is bringing a pane in —
/// and takes it; the hook's late answer finds the workspace and lands.
#[test]
fn a_close_that_arrives_while_a_fork_is_making_its_team_waits_for_the_fork() {
    let mut world = booted();
    world.slow_hook = true;
    let source = SessionKey { agent: "claude".into(), session: "s1".into() };
    let landing = Landing::NewTeam { team: team(7), site: Site::Root, draft: draft() };
    world.intent_now(Intent::Continue { workspace: ws(1), landing, source, how: Continuation::Fork, member: draft() });
    // Only the journal's write comes back: the fork's team is published.
    while let Some(event) = world.mail.pop_front() {
        world.send(event);
    }
    // The close offers the fork's pane too: it is landing.
    let offer = close_workspace_offer(&world.state, &ws(1));
    let fork_pane = world.state.ops.values().find_map(|op| if let Kind::Fork(fork) = &op.kind { Some(fork.pane) } else { None }).expect("the fork");
    assert!(offer.stops.contains(&fork_pane), "{:?}", offer.stops);
    let close = world.intent_now(Intent::CloseWorkspace { workspace: ws(1), consent: Consent { stops: offer.stops, folders: offer.folders, tickets: offer.creations } });
    assert_eq!(world.refusal(close), None);
    assert_eq!(close_phase(&world), Some(TearPhase::Queued), "the close waits behind the fork");
    world.quiesce();
    world.wait_out();
    assert!(world.state.world.workspaces.contains_key(&ws(1)), "not gone while the fork is still bringing its pane in");
    // The plugin's hook answers: the conversation was carried. Then the close goes on.
    world.slow_hook = false;
    world.quiesce();
    world.wait_out();
    assert!(!world.state.world.workspaces.contains_key(&ws(1)), "the close went through");
    let left: Vec<String> = world.state.ops.iter().filter(|(_, op)| !op.owed).map(|(id, op)| format!("{id} {:?}", op.kind)).collect();
    assert!(left.is_empty(), "nothing is left running: {left:?}");
}

/// The person confirms closing a workspace and, in the close's tail — its
/// rows applied by the deck, the deck's save on its way — asks to remove an
/// orphan worktree of it. The removal is refused: it would outlive the
/// workspace.
#[test]
fn an_orphan_removal_asked_while_its_workspace_is_being_closed_is_refused() {
    let mut world = booted();
    world.save_in_flight = true;
    let consent = Consent { stops: world.state.world.panes.keys().copied().collect(), ..Consent::default() };
    world.intent_now(Intent::CloseWorkspace { workspace: ws(1), consent });
    world.quiesce();
    world.wait_out();
    let asked = world.intent_now(Intent::RemoveUnheld { workspace: ws(1), path: dir("/repo/wt/orphan"), tag: None });
    assert_eq!(world.refusal(asked), Some(Refusal::TargetLeaving));
    world.save_in_flight = false;
    world.send(Event::DeckSaved { revision: Revision(world.revision) });
    world.quiesce();
    world.wait_out();
    let left: Vec<String> = world.state.ops.iter().map(|(id, op)| format!("{id} owed={} {:?}", op.owed, op.kind)).collect();
    assert!(left.is_empty(), "an operation is left that will never end: {left:?}");
}
