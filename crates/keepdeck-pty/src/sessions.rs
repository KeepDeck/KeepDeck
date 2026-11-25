//! The sessions machine's rules: every session of this launch is a row, and
//! stopping one is the stop rule — TERM, then after [`STOP_GRACE`] a request
//! to KILL, then at most [`KILL_BOUND`] from that request for the exit to be
//! seen; past it, or when the KILL could not be sent, the stop is
//! «unconfirmed». An ended row stays until the app exits: «over» never comes
//! back, and ids are never reused, so a stop by id cannot touch a new session
//! of the same pane.
//!
//! Pure `update` and `work` on `keepdeck-fsm`; the handler that signals the
//! processes and the table that owns their handles are the app's. The row's
//! `tag` is whatever the app needs to say whose session it is — this crate
//! never reads it.

use crate::STOP_GRACE;
use keepdeck_fsm::{stay, to, Next, Owed};
use std::collections::BTreeMap;
use std::time::Duration;

/// How long after the KILL request the exit must be seen.
pub const KILL_BOUND: Duration = Duration::from_secs(2);

/// A session's id: never reused within a launch, meaningless in the next.
pub type Id = u64;

/// How a session ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Over {
    /// It exited — on its own, or asked by TERM.
    Exited,
    /// It exited after the KILL.
    Forced,
    /// Its exit was not seen in time, or the KILL could not be sent. The row
    /// keeps no input and no report authority; a late exit is noted on it.
    Unconfirmed { exited_late: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Live,
    /// TERM is sent; the grace runs.
    Stopping,
    /// KILL is asked for; the bound runs from the request.
    Killing,
    Over(Over),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row<T> {
    pub tag: T,
    pub phase: Phase,
    /// The secrets its process tree was given: whoever names one a door
    /// counts, from this terminal, speaks for its pane ([`judge_caller`]).
    pub secrets: PaneSecrets,
}

/// A pane's two secrets, one per door it was handed out for. The MCP door
/// counts either; the bridge only its own, which never stands in an argv.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaneSecrets {
    pub mcp: Option<Secret>,
    pub bridge: Option<Secret>,
}

/// A secret a session was started with. Its Debug prints nothing of it, so a
/// row's Debug cannot carry one into a log.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }

    /// The value itself, for the one door that has to find it in text to
    /// hide it there.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

impl<T> Row<T> {
    pub fn over(&self) -> bool {
        matches!(self.phase, Phase::Over(_))
    }

    /// Input and reports are taken only from a live session.
    pub fn live(&self) -> bool {
        self.phase == Phase::Live
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sessions<T> {
    pub rows: BTreeMap<Id, Row<T>>,
}

impl<T> Default for Sessions<T> {
    fn default() -> Self {
        Sessions { rows: BTreeMap::new() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event<T> {
    /// The table holds the handle of a new session.
    Registered { id: Id, tag: T, secrets: PaneSecrets },
    /// Its process exited.
    Exited { id: Id },
    /// Stop this exact session. Asking again is safe.
    Stop { id: Id },
    /// The handler's word on the KILL it was asked to send.
    Killed { id: Id, sent: bool },
    Grace { id: Id },
    Bound { id: Id },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Term { id: Id },
    Kill { id: Id },
}

/// The row moved on to `phase` — never back to live, so its secrets, which
/// count only while it is live, are let go.
fn with<T: Clone>(sessions: &Sessions<T>, id: Id, phase: Phase) -> Next<Sessions<T>, Effect> {
    let mut next = sessions.clone();
    if let Some(row) = next.rows.get_mut(&id) {
        row.phase = phase;
        row.secrets = PaneSecrets::default();
    }
    to(next)
}

pub fn update<T: Clone>(sessions: &Sessions<T>, event: Event<T>) -> Next<Sessions<T>, Effect> {
    match event {
        Event::Registered { id, tag, secrets } => {
            if sessions.rows.contains_key(&id) {
                return stay();
            }
            let mut next = sessions.clone();
            next.rows.insert(id, Row { tag, phase: Phase::Live, secrets });
            to(next)
        }
        event => {
            let id = match &event {
                Event::Exited { id } | Event::Stop { id } | Event::Killed { id, .. } | Event::Grace { id } | Event::Bound { id } => *id,
                Event::Registered { .. } => unreachable!("handled above"),
            };
            let Some(row) = sessions.rows.get(&id) else { return stay() };
            match (row.phase, event) {
                (Phase::Live, Event::Stop { .. }) => with(sessions, id, Phase::Stopping).run(Effect::Term { id }),
                (Phase::Live | Phase::Stopping, Event::Exited { .. }) => with(sessions, id, Phase::Over(Over::Exited)),
                (Phase::Killing, Event::Exited { .. }) => with(sessions, id, Phase::Over(Over::Forced)),
                (Phase::Over(Over::Unconfirmed { exited_late: false }), Event::Exited { .. }) => {
                    with(sessions, id, Phase::Over(Over::Unconfirmed { exited_late: true }))
                }
                (Phase::Stopping, Event::Grace { .. }) => with(sessions, id, Phase::Killing).run(Effect::Kill { id }),
                (Phase::Killing, Event::Killed { sent: false, .. } | Event::Bound { .. }) => {
                    with(sessions, id, Phase::Over(Over::Unconfirmed { exited_late: false }))
                }
                // A stop of one already stopping or over, a late word on a
                // KILL, a timer of a phase left: nothing changes.
                (_, Event::Stop { .. } | Event::Exited { .. } | Event::Killed { .. } | Event::Grace { .. } | Event::Bound { .. } | Event::Registered { .. }) => stay(),
            }
        }
    }
}

/// Why a caller does not speak for a pane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CallerRefusal {
    /// It named no secret.
    NoSecret,
    /// Its process runs in no live terminal of a pane, or stands further from
    /// one than the door admits: in none at all, in one that is stopping or
    /// over, or in a session a terminal process started, at the MCP door.
    OutsideTerminal,
    /// The live session of its terminal holds another secret, or not one
    /// this door counts.
    WrongSecret,
    /// Its terminal was never registered within [`CALLER_WAIT`]: the table
    /// holds it, the machine does not. A fault of the deck's, not the
    /// caller's.
    NeverRegistered,
    /// What it named as its process is not a process id.
    NamedNotAProcess,
    /// The process it named does not belong to its own terminal: it runs in
    /// another, in none, or only in a session a process there started — a
    /// daemon's worker naming itself.
    NamedOutside,
}

/// How a process stands to a terminal, as the kernel tells it
/// ([`crate::PtySession::standing`]). Ordered from the strictest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// It runs in the terminal's session.
    InTerminal,
    /// It left the session, and its parent runs in it: a helper an agent
    /// started detached, as kimi starts its MCP servers and opencode 2.x its
    /// `serve`.
    ChildOfTerminal,
    /// It runs in a session whose leader a process of the terminal started:
    /// a hook an agent ran detached.
    SessionFromTerminal,
}

impl Standing {
    /// It belongs to the terminal itself: runs in it, or was started from
    /// it. What a door admits that does not reach for hooks, and what a
    /// process named as the sender has to be.
    pub fn strict(self) -> bool {
        match self {
            Standing::InTerminal | Standing::ChildOfTerminal => true,
            Standing::SessionFromTerminal => false,
        }
    }
}

/// Where a caller's process runs, as the session table answers it: in the
/// terminal that is session `id`, of `pane`, and how it stands there; in no
/// terminal; or in none while a spawn is under way, whose process can run
/// before the table holds its terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerPlace<P> {
    Terminal { id: Id, pane: P, standing: Standing },
    Outside,
    OutsideWhileSpawning,
}

/// The process a caller names as the one it speaks from, besides the one
/// the kernel names: nothing, a process — by its id as the caller wrote it,
/// by its place once located — or a name that is not a process id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Named<X> {
    None,
    Process(X),
    NotAProcess,
}

impl<X> Named<X> {
    pub fn map<Y>(self, f: impl FnOnce(X) -> Y) -> Named<Y> {
        match self {
            Named::None => Named::None,
            Named::Process(process) => Named::Process(f(process)),
            Named::NotAProcess => Named::NotAProcess,
        }
    }
}

/// The door a caller knocks at. Which standing it admits and which of the
/// pane's secrets it counts is this rule's, not the door's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Door {
    /// KeepDeck's MCP server: commands, so only the terminal's own
    /// processes, by either secret — kimi, a shared folder and opencode
    /// 2.x reach it with the bridge's.
    Mcp,
    /// The bridge: reports, which agents send from hooks they run detached,
    /// so one session further out, and only by its own secret.
    Bridge,
}

impl Door {
    fn admits(self, standing: Standing) -> bool {
        match self {
            Door::Mcp => standing.strict(),
            Door::Bridge => true,
        }
    }

    fn counts(self, secrets: &PaneSecrets, secret: &Secret) -> bool {
        let holds = |slot: &Option<Secret>| slot.as_ref() == Some(secret);
        match self {
            Door::Mcp => holds(&secrets.mcp) || holds(&secrets.bridge),
            Door::Bridge => holds(&secrets.bridge),
        }
    }
}

/// What the rule says of one caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerVerdict<P> {
    /// It speaks for `pane`.
    Admit(P),
    Refuse(CallerRefusal),
    /// Its process runs in no terminal while a spawn is under way: its own
    /// terminal may not be held yet. Too early to say.
    NotPlaced,
    /// Its process sits in the terminal of session `id`, which the table holds
    /// and the machine has not registered yet: too early to say. A row is
    /// never removed, so this can only mean "not registered yet", and once
    /// false it stays false.
    NotRegistered(Id),
}

/// How long an early caller is waited for, in all: for the spawn under way
/// to hand its terminal to the table, and for the machine to register that
/// terminal.
///
/// From below: the real window is one resumption of the spawn door after the
/// spawn and one hop of the machine's mailbox, far under a second unless the
/// runtime is starved. From above: under a client's handshake timeout
/// (opencode 1.19.6 waits 30 s). It cannot stack: both waits share this one
/// deadline, a machine that is gone ends the wait at once, and a registered
/// session never turns unregistered.
pub const CALLER_WAIT: Duration = Duration::from_secs(2);

/// Whether a caller at `door` speaks for a pane, by where its process runs,
/// the `secret` it named and the process it `named` as the one it speaks
/// from.
///
/// The terminal first: the pane is the one the process runs in, the door
/// decides how far from that terminal it may stand, and the secret only has
/// to be one of that terminal's live session the door counts. So a secret
/// two sessions happen to hold still cannot name the other's pane.
///
/// A named process is held to more than the caller: it has to belong to the
/// same terminal itself, whatever the door. A daemon's worker that a pane's
/// agent left running may stand one session out like a hook does; naming
/// itself, it is refused, as it was when the named process was all the
/// bridge could judge.
///
/// A caller that named no secret, or named a process by something that is
/// not a process id, is refused before anything else and never waited for.
pub fn judge_caller<T, P: Copy>(
    sessions: &Sessions<T>,
    place: &CallerPlace<P>,
    secret: Option<&Secret>,
    named: &Named<CallerPlace<P>>,
    door: Door,
) -> CallerVerdict<P> {
    let Some(secret) = secret else {
        return CallerVerdict::Refuse(CallerRefusal::NoSecret);
    };
    let named = match *named {
        Named::None => None,
        Named::Process(place) => Some(place),
        Named::NotAProcess => return CallerVerdict::Refuse(CallerRefusal::NamedNotAProcess),
    };
    let (id, pane, standing) = match *place {
        CallerPlace::Terminal { id, pane, standing } => (id, pane, standing),
        CallerPlace::Outside => return CallerVerdict::Refuse(CallerRefusal::OutsideTerminal),
        CallerPlace::OutsideWhileSpawning => return CallerVerdict::NotPlaced,
    };
    let Some(row) = sessions.rows.get(&id) else {
        return CallerVerdict::NotRegistered(id);
    };
    if !row.live() || !door.admits(standing) {
        return CallerVerdict::Refuse(CallerRefusal::OutsideTerminal);
    }
    if !door.counts(&row.secrets, secret) {
        return CallerVerdict::Refuse(CallerRefusal::WrongSecret);
    }
    match named {
        None => CallerVerdict::Admit(pane),
        Some(CallerPlace::Terminal { id: theirs, standing, .. }) if theirs == id && standing.strict() => CallerVerdict::Admit(pane),
        Some(CallerPlace::Terminal { .. } | CallerPlace::Outside | CallerPlace::OutsideWhileSpawning) => {
            CallerVerdict::Refuse(CallerRefusal::NamedOutside)
        }
    }
}

/// The verdict once the wait is spent: a caller still in no terminal is
/// outside it, and a terminal still unregistered is refused as never
/// registered. A decision, so it is here and not in the door that waited.
pub fn after_caller_wait<P>(verdict: CallerVerdict<P>) -> Result<P, CallerRefusal> {
    match verdict {
        CallerVerdict::Admit(pane) => Ok(pane),
        CallerVerdict::Refuse(refusal) => Err(refusal),
        CallerVerdict::NotPlaced => Err(CallerRefusal::OutsideTerminal),
        CallerVerdict::NotRegistered(_) => Err(CallerRefusal::NeverRegistered),
    }
}

pub fn work<T>(sessions: &Sessions<T>) -> Owed<Effect, Event<T>>
where
    T: PartialEq,
{
    sessions.rows.iter().fold(Owed::nothing(), |owed, (&id, row)| match row.phase {
        Phase::Stopping => owed.after(STOP_GRACE, Event::Grace { id }),
        Phase::Killing => owed.after(KILL_BOUND, Event::Bound { id }),
        Phase::Live | Phase::Over(_) => owed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_fsm::Work;

    fn step(sessions: &Sessions<&'static str>, event: Event<&'static str>) -> (Sessions<&'static str>, Vec<Effect>) {
        let next = update(sessions, event);
        (next.state.unwrap_or_else(|| sessions.clone()), next.effects)
    }

    fn registered() -> Sessions<&'static str> {
        step(&Sessions::default(), Event::Registered { id: 1, tag: "pane-1", secrets: pair("p-mcp", "p-bridge") }).0
    }

    fn secret(value: &str) -> Secret {
        Secret::new(value)
    }

    fn pair(mcp: &str, bridge: &str) -> PaneSecrets {
        PaneSecrets { mcp: Some(secret(mcp)), bridge: Some(secret(bridge)) }
    }

    fn phase(sessions: &Sessions<&'static str>) -> Phase {
        sessions.rows[&1].phase
    }

    #[test]
    fn a_stop_is_term_then_after_the_grace_a_kill_request() {
        let (stopping, effects) = step(&registered(), Event::Stop { id: 1 });
        assert_eq!(effects, [Effect::Term { id: 1 }]);
        assert_eq!(phase(&stopping), Phase::Stopping);
        let timers: Vec<_> = work(&stopping).into_iter().collect();
        assert_eq!(timers, [Work::After(STOP_GRACE, Event::Grace { id: 1 })]);
        let (killing, effects) = step(&stopping, Event::Grace { id: 1 });
        assert_eq!(effects, [Effect::Kill { id: 1 }]);
        let timers: Vec<_> = work(&killing).into_iter().collect();
        assert_eq!(timers, [Work::After(KILL_BOUND, Event::Bound { id: 1 })], "the bound counts from the request");
    }

    #[test]
    fn an_exit_during_the_grace_is_exited_and_after_the_kill_forced() {
        let (stopping, _) = step(&registered(), Event::Stop { id: 1 });
        assert_eq!(phase(&step(&stopping, Event::Exited { id: 1 }).0), Phase::Over(Over::Exited));
        let (killing, _) = step(&stopping, Event::Grace { id: 1 });
        assert_eq!(phase(&step(&killing, Event::Exited { id: 1 }).0), Phase::Over(Over::Forced));
    }

    #[test]
    fn a_kill_that_could_not_be_sent_is_unconfirmed_at_once_and_a_silent_one_at_the_bound() {
        let (stopping, _) = step(&registered(), Event::Stop { id: 1 });
        let (killing, _) = step(&stopping, Event::Grace { id: 1 });
        let failed = step(&killing, Event::Killed { id: 1, sent: false }).0;
        assert_eq!(phase(&failed), Phase::Over(Over::Unconfirmed { exited_late: false }));
        let sent = step(&killing, Event::Killed { id: 1, sent: true }).0;
        assert_eq!(phase(&sent), Phase::Killing, "sent: the exit is still awaited");
        let silent = step(&sent, Event::Bound { id: 1 }).0;
        assert_eq!(phase(&silent), Phase::Over(Over::Unconfirmed { exited_late: false }));
        // The handler's late word changes nothing; a late exit is noted.
        assert_eq!(step(&silent, Event::Killed { id: 1, sent: true }).0, silent);
        let late = step(&silent, Event::Exited { id: 1 }).0;
        assert_eq!(phase(&late), Phase::Over(Over::Unconfirmed { exited_late: true }));
        assert!(!late.rows[&1].live(), "no input, no reports");
    }

    #[test]
    fn over_never_comes_back_and_a_stop_again_is_safe() {
        let (stopping, _) = step(&registered(), Event::Stop { id: 1 });
        let (again, effects) = step(&stopping, Event::Stop { id: 1 });
        assert!(effects.is_empty(), "no second TERM");
        assert_eq!(again, stopping);
        let over = step(&stopping, Event::Exited { id: 1 }).0;
        for event in [Event::Stop { id: 1 }, Event::Grace { id: 1 }, Event::Bound { id: 1 }, Event::Registered { id: 1, tag: "pane-1", secrets: PaneSecrets::default() }] {
            assert_eq!(step(&over, event).0, over);
        }
        assert!(work(&over).into_iter().next().is_none(), "an ended row needs nothing");
    }

    #[test]
    fn a_session_seen_first_as_over_stays_a_row_with_its_end() {
        let (over, _) = step(&registered(), Event::Exited { id: 1 });
        assert_eq!(over.rows[&1].phase, Phase::Over(Over::Exited));
        assert_eq!(over.rows[&1].tag, "pane-1");
    }

    #[test]
    fn a_stop_by_id_never_touches_another_session() {
        let both = step(&registered(), Event::Registered { id: 2, tag: "pane-1", secrets: PaneSecrets::default() }).0;
        let (stopped, effects) = step(&both, Event::Stop { id: 1 });
        assert_eq!(effects, [Effect::Term { id: 1 }]);
        assert_eq!(stopped.rows[&2].phase, Phase::Live, "a new session of the same pane goes on");
        assert_eq!(step(&both, Event::Stop { id: 9 }).0, both, "an unknown id stops nothing");
    }

    /// Session 1 (secrets p-mcp, p-bridge) registered, and session 2 of
    /// another pane (secrets q-mcp, q-bridge).
    fn two_panes() -> Sessions<&'static str> {
        step(&registered(), Event::Registered { id: 2, tag: "pane-2", secrets: pair("q-mcp", "q-bridge") }).0
    }

    const DOORS: [Door; 2] = [Door::Mcp, Door::Bridge];

    /// A process standing `standing` to the terminal that is session `id`,
    /// of the pane numbered the same.
    fn at(id: Id, standing: Standing) -> CallerPlace<Id> {
        CallerPlace::Terminal { id, pane: id, standing }
    }

    fn in_terminal(id: Id) -> CallerPlace<Id> {
        at(id, Standing::InTerminal)
    }

    /// The rule for a caller at `place` that names `named` as its secret and
    /// no process.
    fn judge(sessions: &Sessions<&'static str>, place: CallerPlace<Id>, named: Option<&str>, door: Door) -> CallerVerdict<Id> {
        judge_caller(sessions, &place, named.map(secret).as_ref(), &Named::None, door)
    }

    #[test]
    fn the_mcp_door_admits_the_terminals_own_processes_by_either_secret_and_no_hook() {
        let sessions = two_panes();
        for standing in [Standing::InTerminal, Standing::ChildOfTerminal] {
            for named in ["p-mcp", "p-bridge"] {
                assert_eq!(judge(&sessions, at(1, standing), Some(named), Door::Mcp), CallerVerdict::Admit(1), "{standing:?} {named}");
            }
        }
        assert_eq!(judge(&sessions, in_terminal(2), Some("q-mcp"), Door::Mcp), CallerVerdict::Admit(2));
        // One session further out: a hook, and as much a daemon's worker
        // whose daemon's starter still runs here. Commands are not theirs.
        for named in ["p-mcp", "p-bridge"] {
            assert_eq!(
                judge(&sessions, at(1, Standing::SessionFromTerminal), Some(named), Door::Mcp),
                CallerVerdict::Refuse(CallerRefusal::OutsideTerminal),
                "{named}",
            );
        }
    }

    #[test]
    fn the_bridge_door_admits_a_hook_one_session_out_by_its_own_secret_only() {
        let sessions = two_panes();
        for standing in [Standing::InTerminal, Standing::ChildOfTerminal, Standing::SessionFromTerminal] {
            assert_eq!(judge(&sessions, at(1, standing), Some("p-bridge"), Door::Bridge), CallerVerdict::Admit(1), "{standing:?}");
            // The MCP secret stands in an argv some agents are given, where
            // any process can read it: it opens no bridge.
            assert_eq!(
                judge(&sessions, at(1, standing), Some("p-mcp"), Door::Bridge),
                CallerVerdict::Refuse(CallerRefusal::WrongSecret),
                "{standing:?}",
            );
        }
    }

    #[test]
    fn the_terminal_decides_the_pane_and_another_panes_secret_names_none() {
        // A process of pane 2's terminal that names pane 1's secret is not
        // pane 1: the terminal comes first.
        let sessions = two_panes();
        for door in DOORS {
            assert_eq!(judge(&sessions, in_terminal(2), Some("p-bridge"), door), CallerVerdict::Refuse(CallerRefusal::WrongSecret), "{door:?}");
            assert_eq!(judge(&sessions, in_terminal(1), Some("stale"), door), CallerVerdict::Refuse(CallerRefusal::WrongSecret), "{door:?}");
        }
    }

    #[test]
    fn a_named_process_must_belong_to_the_callers_own_terminal_itself_at_either_door() {
        let sessions = two_panes();
        let named = |peer: CallerPlace<Id>, place: CallerPlace<Id>, door: Door| {
            judge_caller(&sessions, &peer, Some(&secret("p-bridge")), &Named::Process(place), door)
        };
        // A hook naming its agent's group: the agent runs in the terminal, or
        // was started from it.
        let hook = at(1, Standing::SessionFromTerminal);
        assert_eq!(named(hook, in_terminal(1), Door::Bridge), CallerVerdict::Admit(1));
        assert_eq!(named(hook, at(1, Standing::ChildOfTerminal), Door::Bridge), CallerVerdict::Admit(1));
        for door in DOORS {
            let peer = in_terminal(1);
            assert_eq!(named(peer, at(1, Standing::ChildOfTerminal), door), CallerVerdict::Admit(1), "{door:?}");
            // A daemon's worker naming itself stands one session out, as a
            // hook does; the process a sender names may not.
            assert_eq!(named(peer, at(1, Standing::SessionFromTerminal), door), CallerVerdict::Refuse(CallerRefusal::NamedOutside), "{door:?}");
            // Another pane's process, a process of no pane, one not placed.
            for place in [in_terminal(2), CallerPlace::Outside, CallerPlace::OutsideWhileSpawning] {
                assert_eq!(named(peer, place, door), CallerVerdict::Refuse(CallerRefusal::NamedOutside), "{door:?} {place:?}");
            }
        }
        assert_eq!(named(hook, at(1, Standing::SessionFromTerminal), Door::Bridge), CallerVerdict::Refuse(CallerRefusal::NamedOutside));
    }

    #[test]
    fn a_name_that_is_not_a_process_is_refused_at_once_wherever_the_caller_is() {
        let sessions = two_panes();
        for place in [CallerPlace::Outside, CallerPlace::OutsideWhileSpawning, in_terminal(1), in_terminal(3)] {
            assert_eq!(
                judge_caller(&sessions, &place, Some(&secret("p-bridge")), &Named::NotAProcess, Door::Bridge),
                CallerVerdict::Refuse(CallerRefusal::NamedNotAProcess),
                "{place:?}",
            );
        }
    }

    #[test]
    fn a_caller_in_no_terminal_or_in_one_that_is_not_live_is_outside() {
        let sessions = two_panes();
        let (stopping, _) = step(&sessions, Event::Stop { id: 1 });
        let (killing, _) = step(&stopping, Event::Grace { id: 1 });
        let over = step(&killing, Event::Exited { id: 1 }).0;
        for door in DOORS {
            // A leftover of a closed pane: in no pane's terminal.
            assert_eq!(judge(&sessions, CallerPlace::Outside, Some("p-bridge"), door), CallerVerdict::Refuse(CallerRefusal::OutsideTerminal));
            // A closing session's row exists and is not live, whatever it is in.
            for closing in [&stopping, &killing, &over] {
                assert_eq!(judge(closing, in_terminal(1), Some("p-bridge"), door), CallerVerdict::Refuse(CallerRefusal::OutsideTerminal));
            }
        }
    }

    #[test]
    fn a_terminal_not_yet_registered_is_too_early_to_judge() {
        for door in DOORS {
            assert_eq!(judge(&two_panes(), in_terminal(3), Some("r"), door), CallerVerdict::NotRegistered(3), "{door:?}");
        }
    }

    #[test]
    fn a_caller_in_no_terminal_while_a_spawn_is_under_way_is_too_early_to_judge() {
        // Its own terminal may be the one not handed to the table yet.
        for door in DOORS {
            assert_eq!(judge(&two_panes(), CallerPlace::OutsideWhileSpawning, Some("p-bridge"), door), CallerVerdict::NotPlaced, "{door:?}");
        }
    }

    #[test]
    fn no_secret_is_refused_at_once_wherever_the_caller_is() {
        // Never waited for, not even in a terminal not registered yet or
        // while a spawn is under way.
        let sessions = two_panes();
        for door in DOORS {
            for place in [CallerPlace::Outside, CallerPlace::OutsideWhileSpawning, in_terminal(1), in_terminal(3)] {
                assert_eq!(judge(&sessions, place, None, door), CallerVerdict::Refuse(CallerRefusal::NoSecret), "{door:?} {place:?}");
            }
        }
    }

    #[test]
    fn a_spent_wait_refuses_what_is_still_too_early_and_keeps_every_other_verdict() {
        assert_eq!(after_caller_wait::<Id>(CallerVerdict::NotPlaced), Err(CallerRefusal::OutsideTerminal));
        assert_eq!(after_caller_wait::<Id>(CallerVerdict::NotRegistered(3)), Err(CallerRefusal::NeverRegistered));
        assert_eq!(after_caller_wait(CallerVerdict::Admit(1)), Ok(1));
        for refusal in [
            CallerRefusal::NoSecret,
            CallerRefusal::OutsideTerminal,
            CallerRefusal::WrongSecret,
            CallerRefusal::NamedNotAProcess,
            CallerRefusal::NamedOutside,
        ] {
            assert_eq!(after_caller_wait::<Id>(CallerVerdict::Refuse(refusal)), Err(refusal));
        }
    }

    #[test]
    fn a_session_holds_its_secrets_only_while_it_is_live() {
        let live = registered();
        assert_eq!(live.rows[&1].secrets, pair("p-mcp", "p-bridge"));
        let (stopping, _) = step(&live, Event::Stop { id: 1 });
        assert_eq!(stopping.rows[&1].secrets, PaneSecrets::default(), "stopping");
        let over = step(&live, Event::Exited { id: 1 }).0;
        assert_eq!(over.rows[&1].secrets, PaneSecrets::default(), "over");
    }

    #[test]
    fn a_secret_never_shows_in_a_debug_print() {
        let printed = format!("{:?}", two_panes());
        for value in ["p-mcp", "p-bridge", "q-mcp", "q-bridge"] {
            assert!(!printed.contains(value), "{printed}");
        }
        assert_eq!(secret("p-mcp").expose(), "p-mcp");
    }
}
