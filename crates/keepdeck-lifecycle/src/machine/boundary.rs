//! The start boundary, for an operation that takes over launches already
//! admitted into what it takes away: a teardown's panes and folders, a fork
//! being taken back's checkout. Each launch it takes is cancelled at the
//! boundary if its process does not exist yet, and awaited — for at most
//! [`REGISTRATION_WAIT`] — if it does, so its session is stopped by id.
//! One flow for every operation that needs it.

use super::launch::Attempt;
use super::{Effect, Event, Kind, Op, State, Timer, REGISTRATION_WAIT};
use crate::ids::{AttemptId, OpId};
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

/// The wait for `op`'s started launches to register ran out.
pub fn waited(state: &mut State, op: OpId) {
    if let Some(boundary) = state.ops.get_mut(&op).and_then(Op::boundary_mut) {
        boundary.waited = true;
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Boundary {
    /// Admitted launches taken over, waiting for the boundary's word.
    pub taken: BTreeSet<AttemptId>,
    /// Of those, the ones whose process exists: their sessions are awaited.
    pub started: BTreeSet<AttemptId>,
    /// The wait for the started ones to register ran out.
    pub waited: bool,
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
    /// started one has registered — or the wait for it ran out.
    pub fn settled(&self, attempts: &BTreeMap<AttemptId, Attempt>) -> bool {
        self.taken.is_empty() && (self.waited || self.started.iter().all(|attempt| !attempts.contains_key(attempt)))
    }

    /// What it owes while it is not settled: the cancel at the boundary,
    /// and the wait for the started ones.
    pub fn work(&self, op: OpId, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
        if !self.taken.is_empty() {
            owed = owed.run(Effect::Cancel { op, attempts: self.taken.iter().copied().collect() });
        }
        if !self.started.is_empty() && !self.waited {
            owed = owed.after(REGISTRATION_WAIT, Event::Timer(Timer::Registration { op }));
        }
        owed
    }
}
