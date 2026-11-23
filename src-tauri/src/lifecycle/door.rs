//! The waiting door: one helper for every IPC command that asks the machine
//! and waits for its answer.
//!
//! The wait is set up before the ask is sent, and the answer finds it by the
//! ask's id, once. The door waits for the answer or for the machine's state
//! stream to end, whichever comes first: a machine gone before the send means
//! nothing was done (`Unavailable`); gone after it, unanswered, means the next
//! launch settles it (`Unknown`). An answer ready together with the end is
//! still the answer.

use keepdeck_fsm_runtime::Runtime;
use keepdeck_lifecycle::ids::AskId;
use keepdeck_lifecycle::machine::{Event, State};
use keepdeck_lifecycle::model::{Answer, Reply};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

/// The doors waiting for their answers.
#[derive(Clone, Default)]
pub struct Waiters(Arc<Mutex<HashMap<AskId, oneshot::Sender<Answer>>>>);

impl Waiters {
    fn register(&self, ask: AskId) -> oneshot::Receiver<Answer> {
        let (tx, rx) = oneshot::channel();
        self.0.lock().expect("waiters").insert(ask, tx);
        rx
    }

    fn forget(&self, ask: AskId) {
        self.0.lock().expect("waiters").remove(&ask);
    }

    /// The machine's answer to `ask`, handed to its door — once.
    pub fn deliver(&self, ask: AskId, answer: Answer) {
        if let Some(waiter) = self.0.lock().expect("waiters").remove(&ask) {
            let _ = waiter.send(answer);
        }
    }
}

/// A handle on the running machine, for the doors.
pub struct Door<S = State, E = Event> {
    machine: Runtime<S, E>,
    waiters: Waiters,
    asks: Arc<AtomicU64>,
}

impl<S, E> Clone for Door<S, E> {
    fn clone(&self) -> Self {
        Door { machine: self.machine.clone(), waiters: self.waiters.clone(), asks: self.asks.clone() }
    }
}

impl<S: Send + Sync + 'static, E: Clone + PartialEq + Send + 'static> Door<S, E> {
    pub fn new(machine: Runtime<S, E>, waiters: Waiters) -> Door<S, E> {
        Door { machine, waiters, asks: Arc::new(AtomicU64::new(0)) }
    }

    pub fn machine(&self) -> &Runtime<S, E> {
        &self.machine
    }

    /// Send an event that needs no answer.
    pub fn tell(&self, event: E) {
        self.machine.send(event);
    }

    /// Ask, and wait for the one answer.
    pub async fn ask(&self, make: impl FnOnce(AskId) -> E) -> Reply {
        let ask = AskId(self.asks.fetch_add(1, Ordering::Relaxed) + 1);
        let mut answer = self.waiters.register(ask);
        let mut states = self.machine.state();
        if states.has_changed().is_err() {
            self.waiters.forget(ask);
            return Reply::Unavailable;
        }
        self.machine.send(make(ask));
        loop {
            tokio::select! {
                biased;
                got = &mut answer => {
                    return match got {
                        Ok(answer) => Reply::Answered { answer },
                        Err(_) => Reply::Unknown,
                    };
                }
                changed = states.changed() => {
                    if changed.is_err() {
                        self.waiters.forget(ask);
                        return match answer.try_recv() {
                            Ok(answer) => Reply::Answered { answer },
                            Err(_) => Reply::Unknown,
                        };
                    }
                }
            }
        }
    }
}
