//! The start boundary, for an operation that takes over launches already
//! admitted into what it takes away: a teardown's panes and folders, a fork
//! being taken back's checkout. Each launch it takes is cancelled at the
//! boundary if its process does not exist yet, and awaited — for at most
//! [`REGISTRATION_WAIT`] — if it does, so its session is stopped by id. A
//! launch whose session has not registered when the wait runs out is given
//! up: it holds its pane no longer, and its session is late if it comes.
//! One flow for every operation that needs it.

use super::launch::Attempt;
use super::{Effect, Event, Kind, Op, State, Timer, REGISTRATION_WAIT};
use crate::domain::ids::{AttemptId, OpId};
use keepdeck_fsm::Owed;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

impl Op {
    /// The start boundary of an operation that takes launches over.
    pub fn boundary_mut(&mut self) -> Option<&mut Boundary> {
        match &mut self.kind {
            Kind::Teardown(teardown) => Some(&mut teardown.boundary),
            Kind::Fork(fork) => Some(&mut fork.boundary),
            _ => None,
        }
    }
}

/// The boundary's word on the launches `op` took over.
pub fn cancelled(state: &mut State, op: OpId, started: Vec<AttemptId>) {
    let State { ops, attempts, .. } = state;
    if let Some(boundary) = ops.get_mut(&op).and_then(Op::boundary_mut) {
        boundary.cancelled(attempts, op, &started);
    }
}

/// The wait for `op`'s started launches to register ran out: the ones still
/// unregistered are given up, so the boundary settles and their panes are
/// free.
pub fn waited(state: &mut State, op: OpId) {
    let State { ops, attempts, late, .. } = state;
    if let Some(boundary) = ops.get_mut(&op).and_then(Op::boundary_mut) {
        for attempt in std::mem::take(&mut boundary.started) {
            if attempts.remove(&attempt).is_some() {
                late.insert(attempt);
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Boundary {
    /// Admitted launches taken over, waiting for the boundary's word.
    pub taken: BTreeSet<AttemptId>,
    /// Of those, the ones whose process exists: their sessions are awaited.
    pub started: BTreeSet<AttemptId>,
}

impl Boundary {
    /// Take over, for `op`, every admitted launch `covered` picks that no
    /// operation has taken yet.
    pub fn take(&mut self, attempts: &mut BTreeMap<AttemptId, Attempt>, op: OpId, covered: impl Fn(&Attempt) -> bool) {
        for (&attempt, row) in attempts.iter_mut() {
            if row.by.is_none() && covered(row) {
                row.by = Some(op);
                self.taken.insert(attempt);
            }
        }
    }

    /// Take over, for `op`, what `from` was waiting for at the boundary — the
    /// boundary of an operation a Close took over. The launches it took are
    /// `op`'s now: their cancel is asked again by `op`, and their word comes
    /// to it. A launch nobody waits for any more is one a stop can overtake.
    pub fn inherit(&mut self, attempts: &mut BTreeMap<AttemptId, Attempt>, op: OpId, from: &mut Boundary) {
        for attempt in from.taken.iter().chain(&from.started) {
            if let Some(row) = attempts.get_mut(attempt) {
                row.by = Some(op);
            }
        }
        self.taken.append(&mut from.taken);
        self.started.append(&mut from.started);
    }

    /// The boundary's word: the `started` ones are awaited, the others never
    /// start and are done.
    pub fn cancelled(&mut self, attempts: &mut BTreeMap<AttemptId, Attempt>, op: OpId, started: &[AttemptId]) {
        for attempt in std::mem::take(&mut self.taken) {
            if started.contains(&attempt) {
                self.started.insert(attempt);
            }
        }
        attempts.retain(|attempt, row| row.by != Some(op) || started.contains(attempt));
    }

    /// Settled: nothing taken still waits for the boundary's word, and every
    /// started one has registered — or was given up when the wait ran out.
    pub fn settled(&self, attempts: &BTreeMap<AttemptId, Attempt>) -> bool {
        self.taken.is_empty() && self.started.iter().all(|attempt| !attempts.contains_key(attempt))
    }

    /// What it owes while it is not settled: the cancel at the boundary,
    /// and the wait for the started ones.
    pub fn work(&self, op: OpId, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
        if !self.taken.is_empty() {
            owed = owed.run(Effect::Cancel { op, attempts: self.taken.iter().copied().collect() });
        }
        if !self.started.is_empty() {
            owed = owed.after(REGISTRATION_WAIT, Event::Timer(Timer::Registration { op }));
        }
        owed
    }
}
