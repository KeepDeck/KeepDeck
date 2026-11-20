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
    Registered { id: Id, tag: T },
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

fn with<T: Clone>(sessions: &Sessions<T>, id: Id, phase: Phase) -> Next<Sessions<T>, Effect> {
    let mut next = sessions.clone();
    if let Some(row) = next.rows.get_mut(&id) {
        row.phase = phase;
    }
    to(next)
}

pub fn update<T: Clone>(sessions: &Sessions<T>, event: Event<T>) -> Next<Sessions<T>, Effect> {
    match event {
        Event::Registered { id, tag } => {
            if sessions.rows.contains_key(&id) {
                return stay();
            }
            let mut next = sessions.clone();
            next.rows.insert(id, Row { tag, phase: Phase::Live });
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
        step(&Sessions::default(), Event::Registered { id: 1, tag: "pane-1" }).0
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
        for event in [Event::Stop { id: 1 }, Event::Grace { id: 1 }, Event::Bound { id: 1 }, Event::Registered { id: 1, tag: "pane-1" }] {
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
        let both = step(&registered(), Event::Registered { id: 2, tag: "pane-1" }).0;
        let (stopped, effects) = step(&both, Event::Stop { id: 1 });
        assert_eq!(effects, [Effect::Term { id: 1 }]);
        assert_eq!(stopped.rows[&2].phase, Phase::Live, "a new session of the same pane goes on");
        assert_eq!(step(&both, Event::Stop { id: 9 }).0, both, "an unknown id stops nothing");
    }
}
