//! The start boundary: one record per admitted launch attempt — admitted,
//! process exists, cancelled — changed only under that record's lock. The
//! spawn door holds the lock across the whole OS spawn and the handle's
//! transfer to the table, so a Close's cancel can never find a launch
//! halfway: either the attempt is cancelled and its process never starts, or
//! its process exists and the Close stops its session by id. A cancel that
//! comes before the door has its admission leaves a tombstone, and the late
//! admission cannot revive it.

use keepdeck_lifecycle::domain::ids::{AttemptId, SessionId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    Admitted,
    Exists(SessionId),
    Cancelled,
}

/// Why the door did not start the process.
#[derive(Debug, PartialEq, Eq)]
pub enum NotStarted {
    /// A Close cancelled the attempt first.
    Cancelled,
    /// This attempt already started its process: one admission, one launch.
    AlreadyStarted,
    /// The start itself failed.
    Failed(String),
}

#[derive(Default)]
pub struct Boundary {
    records: Mutex<HashMap<AttemptId, Arc<Mutex<Attempt>>>>,
}

impl Boundary {
    fn record(&self, attempt: AttemptId) -> Arc<Mutex<Attempt>> {
        self.records.lock().expect("boundary").entry(attempt).or_insert_with(|| Arc::new(Mutex::new(Attempt::Admitted))).clone()
    }

    /// Cross the boundary: under the attempt's lock, `start` the process and
    /// hand it over — unless the attempt was cancelled. Only an admitted
    /// attempt enters the OS spawn.
    pub fn cross(&self, attempt: AttemptId, start: impl FnOnce() -> Result<SessionId, String>) -> Result<SessionId, NotStarted> {
        let record = self.record(attempt);
        let mut state = record.lock().expect("attempt");
        match *state {
            Attempt::Cancelled => Err(NotStarted::Cancelled),
            Attempt::Exists(_) => Err(NotStarted::AlreadyStarted),
            Attempt::Admitted => {
                let session = start().map_err(NotStarted::Failed)?;
                *state = Attempt::Exists(session);
                Ok(session)
            }
        }
    }

    /// Cancel these attempts; the ones whose process already exists are
    /// answered — the Close stops their sessions by id.
    pub fn cancel(&self, attempts: &[AttemptId]) -> Vec<AttemptId> {
        let mut started = Vec::new();
        for &attempt in attempts {
            let record = self.record(attempt);
            let mut state = record.lock().expect("attempt");
            match *state {
                Attempt::Admitted => *state = Attempt::Cancelled,
                Attempt::Exists(_) => started.push(attempt),
                Attempt::Cancelled => {}
            }
        }
        started
    }

    #[cfg(test)]
    pub fn state(&self, attempt: AttemptId) -> Option<Attempt> {
        self.records.lock().unwrap().get(&attempt).map(|record| *record.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn a_cancel_before_the_admission_leaves_a_tombstone_a_late_admission_cannot_revive() {
        let boundary = Boundary::default();
        assert_eq!(boundary.cancel(&[AttemptId(1)]), Vec::<AttemptId>::new());
        assert_eq!(boundary.state(AttemptId(1)), Some(Attempt::Cancelled));
        let started = boundary.cross(AttemptId(1), || panic!("a cancelled attempt never starts"));
        assert_eq!(started, Err(NotStarted::Cancelled));
    }

    #[test]
    fn only_an_admitted_attempt_enters_the_spawn_and_only_once() {
        let boundary = Boundary::default();
        assert_eq!(boundary.cross(AttemptId(2), || Ok(SessionId(7))), Ok(SessionId(7)));
        assert_eq!(boundary.cross(AttemptId(2), || panic!("a second launch")), Err(NotStarted::AlreadyStarted));
        assert_eq!(boundary.cancel(&[AttemptId(2)]), [AttemptId(2)], "its process exists: stopped by id");
    }

    #[test]
    fn a_failed_start_leaves_the_attempt_admitted_and_says_why() {
        let boundary = Boundary::default();
        assert_eq!(boundary.cross(AttemptId(3), || Err("no such program".into())), Err(NotStarted::Failed("no such program".into())));
        assert_eq!(boundary.state(AttemptId(3)), Some(Attempt::Admitted));
    }

    #[test]
    fn a_cancel_during_the_spawn_waits_for_the_lock_and_sees_the_process() {
        let boundary = Arc::new(Boundary::default());
        let (entered, spawned) = (mpsc::channel(), mpsc::channel::<()>());
        let door = {
            let boundary = boundary.clone();
            let (tell, wait) = (entered.0, spawned.1);
            thread::spawn(move || {
                boundary.cross(AttemptId(4), || {
                    tell.send(()).unwrap();
                    // Under the lock, in the middle of the OS spawn.
                    wait.recv().unwrap();
                    Ok(SessionId(9))
                })
            })
        };
        entered.1.recv().unwrap();
        let cancel = {
            let boundary = boundary.clone();
            thread::spawn(move || boundary.cancel(&[AttemptId(4)]))
        };
        thread::sleep(Duration::from_millis(50));
        assert!(!cancel.is_finished(), "the cancel waits for the spawn's lock");
        spawned.0.send(()).unwrap();
        assert_eq!(door.join().unwrap(), Ok(SessionId(9)));
        assert_eq!(cancel.join().unwrap(), [AttemptId(4)], "and finds the process existing");
    }
}
