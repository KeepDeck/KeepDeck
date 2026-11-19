#![doc = include_str!("../README.md")]

use keepdeck_fsm::{Next, Owed, Work};
use std::future::Future;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

/// The feature's handler: its side that touches the world.
///
/// It is handed every effect — first those `update` asked for, then the new
/// work the state needs, each in the order listed — on the machine's own task,
/// one at a time. So it must not block: long work goes through
/// [`Events::spawn`], and its result comes back as an event.
pub trait Effects<F, E>: Send + 'static {
    fn run(&mut self, effect: F, events: &Events<E>);
}

/// The way back into the machine, for the handler and the work it starts.
///
/// It does not keep the machine alive: when the last [`Runtime`] handle is
/// dropped, the machine ends even while its work still runs.
pub struct Events<E>(mpsc::WeakUnboundedSender<Mail<E>>);

impl<E> Clone for Events<E> {
    fn clone(&self) -> Self {
        Events(self.0.clone())
    }
}

impl<E: Send + 'static> Events<E> {
    /// Send the machine an event. False once the machine is gone, so work
    /// that keeps sending — a subscription — knows to stop.
    pub fn send(&self, event: E) -> bool {
        match self.0.upgrade() {
            Some(machine) => machine.send(Mail::Event(event)).is_ok(),
            None => false,
        }
    }

    /// Start long work. Its event, if it has one, arrives when it ends.
    ///
    /// Work that fails or panics sends nothing: the framework recovers
    /// nothing. A feature that must know turns the failure into an event of
    /// its own.
    pub fn spawn(&self, work: impl Future<Output = Option<E>> + Send + 'static) {
        let events = self.clone();
        tokio::spawn(async move {
            if let Some(event) = work.await {
                events.send(event);
            }
        });
    }
}

/// A state and its version: the number of changes since the machine started.
///
/// A reader that also fetches the state another way — a command, say — keeps
/// whichever copy has the higher version.
#[derive(Clone, Debug, PartialEq)]
pub struct At<T> {
    pub version: u64,
    pub value: T,
}

/// What reaches the machine's task: an event, or a timer with its arming.
enum Mail<E> {
    Event(E),
    Timer(u64),
}

/// What runs for one piece of owed work.
enum Live {
    /// Handed over; it is never stopped, so there is nothing to hold.
    Effect,
    /// Armed under this number, which its firing carries back.
    Timer(u64, JoinHandle<()>),
}

/// A running machine. Outside sees only its state: its effects go to the
/// feature's handler and nowhere else.
///
/// Handles are cheap to clone. The machine ends when the last one is
/// dropped, and with it the stream of its states and its timers.
pub struct Runtime<S, E> {
    mailbox: mpsc::UnboundedSender<Mail<E>>,
    state: watch::Receiver<At<S>>,
}

impl<S, E> Clone for Runtime<S, E> {
    fn clone(&self) -> Self {
        Runtime { mailbox: self.mailbox.clone(), state: self.state.clone() }
    }
}

impl<S, E> Runtime<S, E>
where
    S: Send + Sync + 'static,
    E: Clone + PartialEq + Send + 'static,
{
    /// Start a machine in `initial` on a task of its own; the work `initial`
    /// needs is handed over first.
    ///
    /// `update` and `work` are plain functions, not closures: they capture
    /// nothing, so the signature itself says they are pure.
    ///
    /// Call it where a tokio runtime is entered: the machine is a tokio task.
    /// A machine whose states need timers also needs that runtime's time
    /// driver; without it, the machine panics when it arms its first timer.
    pub fn start<F, X>(initial: S, update: fn(&S, E) -> Next<S, F>, work: fn(&S) -> Owed<F, E>, mut effects: X) -> Self
    where
        F: Clone + PartialEq + Send + 'static,
        X: Effects<F, E>,
    {
        let (mailbox, mut mail) = mpsc::unbounded_channel();
        let (publish, state) = watch::channel(At { version: 0, value: initial });
        let events = Events(mailbox.downgrade());
        tokio::spawn(async move {
            let mut started = Started::none();
            let owed = work(&publish.borrow().value);
            started.reconcile(owed, &mut effects, &events);
            while let Some(mail) = mail.recv().await {
                let event = match mail {
                    Mail::Event(event) => event,
                    Mail::Timer(arming) => match started.fired(arming) {
                        Some(event) => event,
                        // An arming of a state already left: dropped.
                        None => continue,
                    },
                };
                let next = update(&publish.borrow().value, event);
                let moved = next.state.is_some();
                if let Some(state) = next.state {
                    let version = publish.borrow().version + 1;
                    publish.send_replace(At { version, value: state });
                }
                // The effects of this event, in order; then what the new state needs.
                for effect in next.effects {
                    effects.run(effect, &events);
                }
                if moved {
                    let owed = work(&publish.borrow().value);
                    started.reconcile(owed, &mut effects, &events);
                }
            }
        });
        Runtime { mailbox, state }
    }

    /// Send the machine an event. Needs no tokio runtime, so a plain
    /// synchronous command can call it.
    pub fn send(&self, event: E) {
        // Fails only once the machine's task is gone, and then there is
        // nobody to tell: whoever cares watches the state stream end.
        let _ = self.mailbox.send(Mail::Event(event));
    }

    /// The stream of states: the latest one, then each change. It keeps only
    /// the latest, so a reader may miss the states in between; a fact that
    /// stays true once it is true cannot be missed. Ends when the machine's
    /// task is gone.
    pub fn state(&self) -> watch::Receiver<At<S>> {
        self.state.clone()
    }
}

/// The owed work that runs now, and the number of the last timer armed. Its
/// timers stop when it is dropped — when the machine ends, by a panic too.
struct Started<F, E> {
    work: Vec<(Work<F, E>, Live)>,
    armings: u64,
}

impl<F, E> Started<F, E>
where
    F: Clone + PartialEq,
    E: Clone + PartialEq + Send + 'static,
{
    fn none() -> Self {
        Started { work: Vec::new(), armings: 0 }
    }

    /// The event of the timer armed under `arming`, if that arming still runs.
    fn fired(&self, arming: u64) -> Option<E> {
        self.work.iter().find_map(|(work, live)| match (work, live) {
            (Work::After(_, event), Live::Timer(armed, _)) if *armed == arming => Some(event.clone()),
            (Work::After(..) | Work::Run(_), Live::Timer(..) | Live::Effect) => None,
        })
    }

    /// Keep what runs equal to what is owed. An effect no longer owed is left
    /// to finish, and its result still comes back. A timer no longer owed is
    /// stopped; a firing already on its way is dropped by its arming (see
    /// `fired`). New work starts in the order it is listed, and a timer counts
    /// from here, not from when its task first runs.
    fn reconcile<X: Effects<F, E>>(&mut self, owed: Owed<F, E>, effects: &mut X, events: &Events<E>) {
        let owed: Vec<_> = owed.into_iter().collect();
        self.work.retain(|(work, live)| {
            let kept = owed.contains(work);
            if let (false, Live::Timer(_, timer)) = (kept, live) {
                timer.abort();
            }
            kept
        });
        for work in owed {
            if self.work.iter().any(|(already, _)| *already == work) {
                continue;
            }
            let live = match &work {
                Work::Run(effect) => {
                    effects.run(effect.clone(), events);
                    Live::Effect
                }
                Work::After(delay, _) => {
                    self.armings += 1;
                    let (arming, machine) = (self.armings, events.0.clone());
                    let due = tokio::time::sleep(*delay);
                    Live::Timer(
                        arming,
                        tokio::spawn(async move {
                            due.await;
                            if let Some(machine) = machine.upgrade() {
                                let _ = machine.send(Mail::Timer(arming));
                            }
                        }),
                    )
                }
            };
            self.work.push((work, live));
        }
    }
}

impl<F, E> Drop for Started<F, E> {
    fn drop(&mut self) {
        for (_, live) in &self.work {
            if let Live::Timer(_, timer) = live {
                timer.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! A timer's firing, put in the mailbox directly: the queue a race makes,
    //! made exact.
    use super::*;
    use keepdeck_fsm::{stay, to};
    use std::time::Duration;

    const SECOND: Duration = Duration::from_secs(1);

    #[derive(Clone, Debug, PartialEq)]
    enum Wait {
        Armed,
        Left,
        Fired,
    }
    #[derive(Clone, Debug, PartialEq)]
    enum Ev {
        Leave,
        Back,
        Fire,
    }

    fn update(wait: &Wait, event: Ev) -> Next<Wait, ()> {
        match (wait, event) {
            (Wait::Armed, Ev::Leave) => to(Wait::Left),
            (Wait::Left, Ev::Back) => to(Wait::Armed),
            (Wait::Armed | Wait::Left, Ev::Fire) => to(Wait::Fired),
            (Wait::Left | Wait::Fired, Ev::Leave) | (Wait::Armed | Wait::Fired, Ev::Back) | (Wait::Fired, Ev::Fire) => stay(),
        }
    }
    fn work(wait: &Wait) -> Owed<(), Ev> {
        match wait {
            Wait::Armed => Owed::nothing().after(SECOND, Ev::Fire),
            Wait::Left | Wait::Fired => Owed::nothing(),
        }
    }
    struct Nothing;
    impl Effects<(), Ev> for Nothing {
        fn run(&mut self, (): (), _: &Events<Ev>) {}
    }

    /// The machine's first timer is armed under 1, so its firing carries 1.
    #[tokio::test(start_paused = true)]
    async fn a_stale_timer_is_dropped_while_the_same_timer_is_needed_again() {
        let machine = Runtime::start(Wait::Armed, update, work, Nothing);
        machine.send(Ev::Leave);
        machine.send(Ev::Back); // the same timer is needed again, under arming 2
        machine.mailbox.send(Mail::Timer(1)).expect("the machine"); // arming 1 fired, behind both
        tokio::time::sleep(SECOND / 2).await;
        assert_eq!(machine.state().borrow().value, Wait::Armed, "the firing of arming 1 was dropped");
        tokio::time::sleep(SECOND).await;
        assert_eq!(machine.state().borrow().value, Wait::Fired, "arming 2 fired");
    }
}
