//! The waiting door: one helper for every IPC command that asks the machine
//! and waits for its answer.
//!
//! The wait is set up before the ask is sent, and the answer finds it by the
//! ask's id, once. The door waits for the answer or for the machine's state
//! stream to end, whichever comes first: a machine gone before the send means
//! nothing was done (`Unavailable`); gone after it, unanswered, means the next
//! launch settles it (`Unknown`). An answer ready together with the end is
//! still the answer.

use crate::domain::ids::AskId;
use crate::domain::machine::{Event, State};
use crate::domain::model::{Answer, Reply};
use keepdeck_fsm_runtime::Runtime;
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

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_fsm::{stay, Next, Owed};
    use keepdeck_fsm_runtime::{Effects, Events};
    use std::time::Duration;

    /// A machine that answers `Answer` asks, never answers `Silent` ones, and
    /// dies on `Die` — on its own task, as a panic in a machine does.
    #[derive(Clone, Debug, PartialEq)]
    enum Probe {
        Answer(AskId),
        Silent(AskId),
        AnswerThenDie(AskId),
        Die,
    }

    #[derive(Clone, Debug, PartialEq)]
    enum Said {
        Answer(AskId),
        Die,
    }

    fn probe_update(_: &u8, event: Probe) -> Next<u8, Said> {
        match event {
            Probe::Answer(ask) => stay().run(Said::Answer(ask)),
            Probe::Silent(_) => stay(),
            Probe::AnswerThenDie(ask) => stay().run(Said::Answer(ask)).run(Said::Die),
            Probe::Die => stay().run(Said::Die),
        }
    }

    fn probe_work(_: &u8) -> Owed<Said, Probe> {
        Owed::nothing()
    }

    struct ProbeHandler(Waiters);

    impl Effects<Said, Probe> for ProbeHandler {
        fn run(&mut self, effect: Said, _: &Events<Probe>) {
            match effect {
                Said::Answer(ask) => self.0.deliver(ask, Answer::Booted { finishing: Vec::new() }),
                Said::Die => panic!("the machine dies"),
            }
        }
    }

    fn probe_door() -> Door<u8, Probe> {
        let waiters = Waiters::default();
        let machine = Runtime::start(0, probe_update, probe_work, ProbeHandler(waiters.clone()));
        Door::new(machine, waiters)
    }

    async fn dead(door: &Door<u8, Probe>) {
        let mut states = door.machine().state();
        door.tell(Probe::Die);
        while states.changed().await.is_ok() {}
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_door_answers_with_the_machines_answer() {
        let door = probe_door();
        assert_eq!(door.ask(Probe::Answer).await, Reply::Answered { answer: Answer::Booted { finishing: Vec::new() } });
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_machine_gone_before_the_ask_is_unavailable() {
        let door = probe_door();
        dead(&door).await;
        assert_eq!(door.ask(Probe::Answer).await, Reply::Unavailable);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_machine_gone_after_the_ask_unanswered_is_unknown() {
        let door = probe_door();
        let asking = {
            let door = door.clone();
            tokio::spawn(async move { door.ask(Probe::Silent).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        door.tell(Probe::Die);
        assert_eq!(asking.await.unwrap(), Reply::Unknown);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_answer_ready_with_the_end_is_still_the_answer() {
        let door = probe_door();
        assert_eq!(door.ask(Probe::AnswerThenDie).await, Reply::Answered { answer: Answer::Booted { finishing: Vec::new() } });
    }
}
