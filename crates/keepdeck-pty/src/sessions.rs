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
    /// The secrets its process tree was given: whoever names one of them
    /// from this terminal speaks for its pane ([`judge_caller`]).
    pub secrets: Vec<Secret>,
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
    Registered { id: Id, tag: T, secrets: Vec<Secret> },
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
        row.secrets.clear();
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
    /// Its process runs in no live terminal of a pane: none at all, or one
    /// that is stopping or over.
    OutsideTerminal,
    /// The live session of its terminal holds another secret.
    WrongSecret,
    /// Its terminal was never registered within [`CALLER_WAIT`]: the table
    /// holds it, the machine does not. A fault of the deck's, not the
    /// caller's.
    NeverRegistered,
}

/// Where a caller's process runs, as the session table answers it: in the
/// terminal that is session `id`, of `pane`; in no terminal; or in none while
/// a spawn is under way, whose process can run before the table holds its
/// terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerPlace<P> {
    Terminal { id: Id, pane: P },
    Outside,
    OutsideWhileSpawning,
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

/// Whether a caller speaks for a pane, by where its process runs and the
/// `secret` it named.
///
/// The terminal first: the pane is the one the process runs in, and the
/// secret only has to belong to that terminal's live session. So a secret two
/// sessions happen to hold still cannot name the other's pane. A caller that
/// named no secret is refused before anything else and never waited for.
pub fn judge_caller<T, P: Copy>(sessions: &Sessions<T>, place: &CallerPlace<P>, secret: Option<&Secret>) -> CallerVerdict<P> {
    let Some(secret) = secret else {
        return CallerVerdict::Refuse(CallerRefusal::NoSecret);
    };
    let (id, pane) = match *place {
        CallerPlace::Terminal { id, pane } => (id, pane),
        CallerPlace::Outside => return CallerVerdict::Refuse(CallerRefusal::OutsideTerminal),
        CallerPlace::OutsideWhileSpawning => return CallerVerdict::NotPlaced,
    };
    let Some(row) = sessions.rows.get(&id) else {
        return CallerVerdict::NotRegistered(id);
    };
    if !row.live() {
        return CallerVerdict::Refuse(CallerRefusal::OutsideTerminal);
    }
    if row.secrets.contains(secret) {
        CallerVerdict::Admit(pane)
    } else {
        CallerVerdict::Refuse(CallerRefusal::WrongSecret)
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
        step(&Sessions::default(), Event::Registered { id: 1, tag: "pane-1", secrets: vec![secret("p-mcp"), secret("p-bridge")] }).0
    }

    fn secret(value: &str) -> Secret {
        Secret::new(value)
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
        for event in [Event::Stop { id: 1 }, Event::Grace { id: 1 }, Event::Bound { id: 1 }, Event::Registered { id: 1, tag: "pane-1", secrets: vec![] }] {
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
        let both = step(&registered(), Event::Registered { id: 2, tag: "pane-1", secrets: vec![] }).0;
        let (stopped, effects) = step(&both, Event::Stop { id: 1 });
        assert_eq!(effects, [Effect::Term { id: 1 }]);
        assert_eq!(stopped.rows[&2].phase, Phase::Live, "a new session of the same pane goes on");
        assert_eq!(step(&both, Event::Stop { id: 9 }).0, both, "an unknown id stops nothing");
    }

    /// Session 1 (secrets p-mcp, p-bridge) registered, and session 2 of
    /// another pane (secret q).
    fn two_panes() -> Sessions<&'static str> {
        step(&registered(), Event::Registered { id: 2, tag: "pane-2", secrets: vec![secret("q")] }).0
    }

    /// A process in the terminal that is session `id`, of the pane numbered
    /// the same.
    fn in_terminal(id: Id) -> CallerPlace<Id> {
        CallerPlace::Terminal { id, pane: id }
    }

    #[test]
    fn a_caller_is_admitted_from_its_live_terminal_by_either_of_its_secrets_for_that_terminals_pane() {
        let sessions = two_panes();
        for named in ["p-mcp", "p-bridge"] {
            assert_eq!(judge_caller(&sessions, &in_terminal(1), Some(&secret(named))), CallerVerdict::Admit(1), "{named}");
        }
        assert_eq!(judge_caller(&sessions, &in_terminal(2), Some(&secret("q"))), CallerVerdict::Admit(2));
    }

    #[test]
    fn the_terminal_decides_the_pane_and_another_panes_secret_names_none() {
        // A process of pane 2's terminal that names pane 1's secret is not
        // pane 1: the terminal comes first.
        let sessions = two_panes();
        assert_eq!(judge_caller(&sessions, &in_terminal(2), Some(&secret("p-mcp"))), CallerVerdict::Refuse(CallerRefusal::WrongSecret));
        assert_eq!(judge_caller(&sessions, &in_terminal(1), Some(&secret("stale"))), CallerVerdict::Refuse(CallerRefusal::WrongSecret));
    }

    #[test]
    fn a_caller_in_no_terminal_or_in_one_that_is_not_live_is_outside() {
        let sessions = two_panes();
        // A daemon's worker, a leftover of a closed pane: in no pane's terminal.
        let outside: CallerPlace<Id> = CallerPlace::Outside;
        assert_eq!(judge_caller(&sessions, &outside, Some(&secret("p-mcp"))), CallerVerdict::Refuse(CallerRefusal::OutsideTerminal));
        // A closing session's row exists and is not live, whatever it is in.
        let (stopping, _) = step(&sessions, Event::Stop { id: 1 });
        assert_eq!(judge_caller(&stopping, &in_terminal(1), Some(&secret("p-mcp"))), CallerVerdict::Refuse(CallerRefusal::OutsideTerminal));
        let (killing, _) = step(&stopping, Event::Grace { id: 1 });
        assert_eq!(judge_caller(&killing, &in_terminal(1), Some(&secret("p-mcp"))), CallerVerdict::Refuse(CallerRefusal::OutsideTerminal));
        let over = step(&killing, Event::Exited { id: 1 }).0;
        assert_eq!(judge_caller(&over, &in_terminal(1), Some(&secret("p-mcp"))), CallerVerdict::Refuse(CallerRefusal::OutsideTerminal));
    }

    #[test]
    fn a_terminal_not_yet_registered_is_too_early_to_judge() {
        assert_eq!(judge_caller(&two_panes(), &in_terminal(3), Some(&secret("r"))), CallerVerdict::NotRegistered(3));
    }

    #[test]
    fn a_caller_in_no_terminal_while_a_spawn_is_under_way_is_too_early_to_judge() {
        // Its own terminal may be the one not handed to the table yet.
        let spawning: CallerPlace<Id> = CallerPlace::OutsideWhileSpawning;
        assert_eq!(judge_caller(&two_panes(), &spawning, Some(&secret("p-mcp"))), CallerVerdict::NotPlaced);
    }

    #[test]
    fn no_secret_is_refused_at_once_wherever_the_caller_is() {
        // Never waited for, not even in a terminal not registered yet or
        // while a spawn is under way.
        let sessions = two_panes();
        for place in [CallerPlace::Outside, CallerPlace::OutsideWhileSpawning, in_terminal(1), in_terminal(3)] {
            assert_eq!(judge_caller(&sessions, &place, None), CallerVerdict::Refuse(CallerRefusal::NoSecret), "{place:?}");
        }
    }

    #[test]
    fn a_spent_wait_refuses_what_is_still_too_early_and_keeps_every_other_verdict() {
        assert_eq!(after_caller_wait::<Id>(CallerVerdict::NotPlaced), Err(CallerRefusal::OutsideTerminal));
        assert_eq!(after_caller_wait::<Id>(CallerVerdict::NotRegistered(3)), Err(CallerRefusal::NeverRegistered));
        assert_eq!(after_caller_wait(CallerVerdict::Admit(1)), Ok(1));
        for refusal in [CallerRefusal::NoSecret, CallerRefusal::OutsideTerminal, CallerRefusal::WrongSecret] {
            assert_eq!(after_caller_wait::<Id>(CallerVerdict::Refuse(refusal)), Err(refusal));
        }
    }

    #[test]
    fn a_session_holds_its_secrets_only_while_it_is_live() {
        let live = registered();
        assert_eq!(live.rows[&1].secrets, [secret("p-mcp"), secret("p-bridge")]);
        let (stopping, _) = step(&live, Event::Stop { id: 1 });
        assert!(stopping.rows[&1].secrets.is_empty(), "stopping");
        let over = step(&live, Event::Exited { id: 1 }).0;
        assert!(over.rows[&1].secrets.is_empty(), "over");
    }

    #[test]
    fn a_secret_never_shows_in_a_debug_print() {
        let printed = format!("{:?}", two_panes());
        for value in ["p-mcp", "p-bridge"] {
            assert!(!printed.contains(value), "{printed}");
        }
        assert_eq!(secret("p-mcp").expose(), "p-mcp");
    }
}
