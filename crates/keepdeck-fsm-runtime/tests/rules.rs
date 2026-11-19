//! The runtime's rules, each on the smallest machine that shows it. Every rule
//! in the README names its test here.
use keepdeck_fsm::{stay, to, Next, Owed};
use keepdeck_fsm_runtime::{At, Effects, Events, Runtime};
use std::future::Future;
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::task::{Context, Waker};
use std::time::Duration;
use tokio::sync::watch;

const MOMENT: Duration = Duration::from_millis(1);
const SECOND: Duration = Duration::from_secs(1);
const HOUR: Duration = Duration::from_secs(3_600);

type Seen<F> = Arc<Mutex<Vec<F>>>;

fn seen<F: Clone>(log: &Seen<F>) -> Vec<F> {
    log.lock().unwrap().clone()
}

/// The tasks alive on this runtime: a machine, its timers, its spawned work.
fn alive_tasks() -> usize {
    tokio::runtime::Handle::current().metrics().num_alive_tasks()
}

/// Wait in real time until `done`, failing after ten seconds: a bound, not an
/// order — what the test waits for is the signal, never the clock.
async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..10_000 {
        if done() {
            return;
        }
        tokio::time::sleep(MOMENT).await;
    }
    panic!("never: {what}");
}

/// A handler that only records what it is handed.
struct Record<F>(Seen<F>);
impl<F: Send + 'static, E> Effects<F, E> for Record<F> {
    fn run(&mut self, effect: F, _: &Events<E>) {
        self.0.lock().unwrap().push(effect);
    }
}

mod counter {
    //! `Set` moves the state; `Ping` does something once and changes nothing.
    //! While the state is odd it needs a `Write` of its value, whose result
    //! `Done` moves it to an even state that needs nothing.
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    pub enum Ev {
        Set(u32),
        Ping(u32),
        Done(u32),
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Fx {
        Write(u32),
        Pong(u32),
    }

    pub fn update(_: &u32, event: Ev) -> Next<u32, Fx> {
        match event {
            Ev::Set(n) => to(n),
            Ev::Ping(n) => stay().run(Fx::Pong(n)),
            Ev::Done(n) => to(1000 + 2 * n),
        }
    }
    pub fn work(state: &u32) -> Owed<Fx, Ev> {
        match state % 2 {
            1 => Owed::nothing().run(Fx::Write(*state)),
            _ => Owed::nothing(),
        }
    }

    /// Records each effect; a `Write` takes 50 ms and then reports `Done`.
    pub struct Writer(pub Seen<Fx>);
    impl Effects<Fx, Ev> for Writer {
        fn run(&mut self, effect: Fx, events: &Events<Ev>) {
            self.0.lock().unwrap().push(effect.clone());
            if let Fx::Write(n) = effect {
                events.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Some(Ev::Done(n))
                });
            }
        }
    }
}

mod listen {
    //! A transition with effects of its own into a state that needs work.
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    pub enum Mode {
        Idle,
        Listening,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Ev {
        Go,
        /// An author who wants to be sure: the transition starts the listener too.
        GoTwice,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Fx {
        Kick(u8),
        Listen(u8),
    }

    pub fn update(mode: &Mode, event: Ev) -> Next<Mode, Fx> {
        match (mode, event) {
            (Mode::Idle, Ev::Go) => to(Mode::Listening).run(Fx::Kick(1)).run(Fx::Kick(2)),
            (Mode::Idle, Ev::GoTwice) => to(Mode::Listening).run(Fx::Listen(1)),
            (Mode::Listening, Ev::Go | Ev::GoTwice) => stay(),
        }
    }
    pub fn work(mode: &Mode) -> Owed<Fx, Ev> {
        match mode {
            Mode::Listening => Owed::nothing().run(Fx::Listen(1)).run(Fx::Listen(2)),
            Mode::Idle => Owed::nothing(),
        }
    }
}

mod wait {
    //! A state that needs a timer, and an event that leaves it while its
    //! handler is held.
    use super::*;

    pub const TIMER: Duration = Duration::from_millis(100);

    #[derive(Clone, Debug, PartialEq)]
    pub enum Wait {
        Armed,
        Left,
        Fired,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Ev {
        Leave,
        Fire,
        /// A fence: handled after everything already in the mailbox.
        Check,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Fx {
        Slow,
        Checked,
    }

    pub fn update(wait: &Wait, event: Ev) -> Next<Wait, Fx> {
        match (wait, event) {
            (Wait::Armed, Ev::Leave) => to(Wait::Left).run(Fx::Slow),
            // A timer delivered once its state is left would show here.
            (Wait::Armed | Wait::Left, Ev::Fire) => to(Wait::Fired),
            (_, Ev::Check) => stay().run(Fx::Checked),
            (Wait::Left | Wait::Fired, Ev::Leave) | (Wait::Fired, Ev::Fire) => stay(),
        }
    }
    pub fn work(wait: &Wait) -> Owed<Fx, Ev> {
        match wait {
            Wait::Armed => Owed::nothing().after(TIMER, Ev::Fire),
            Wait::Left | Wait::Fired => Owed::nothing(),
        }
    }

    /// Records what it is handed, and holds the machine's task on the first
    /// `Slow` until released.
    pub struct Gate(pub Option<std_mpsc::Receiver<()>>, pub Seen<Fx>);
    impl Effects<Fx, Ev> for Gate {
        fn run(&mut self, effect: Fx, _: &Events<Ev>) {
            if effect == Fx::Slow {
                if let Some(release) = self.0.take() {
                    let _ = release.recv();
                }
            }
            self.1.lock().unwrap().push(effect);
        }
    }

    pub fn free() -> Gate {
        Gate(None, Seen::default())
    }
}

// ---------------------------------------------------------------- update or work

#[tokio::test(start_paused = true)]
async fn a_machine_started_in_a_state_does_its_work() {
    let log = Seen::default();
    let _machine = Runtime::start(3, counter::update, counter::work, counter::Writer(log.clone()));
    tokio::time::sleep(MOMENT).await;
    assert_eq!(seen(&log), [counter::Fx::Write(3)], "the state it started in needs a write");

    let _restarted = Runtime::start(3, counter::update, counter::work, counter::Writer(log.clone()));
    tokio::time::sleep(MOMENT).await;
    assert_eq!(seen(&log), [counter::Fx::Write(3), counter::Fx::Write(3)], "started in it again, it writes again");
}

#[tokio::test(start_paused = true)]
async fn an_event_that_changes_no_state_still_does_its_effect_once() {
    let log = Seen::default();
    let machine = Runtime::start(2, counter::update, counter::work, Record(log.clone()));
    machine.send(counter::Ev::Ping(8));
    tokio::time::sleep(MOMENT).await;
    assert_eq!(seen(&log), [counter::Fx::Pong(8)]);
    assert_eq!(*machine.state().borrow(), At { version: 0, value: 2 }, "no change: the version did not move");
}

// ---------------------------------------------------------------- one effect, one path

#[tokio::test(start_paused = true)]
async fn the_same_effect_from_both_paths_is_handed_over_twice() {
    let log = Seen::default();
    let machine = Runtime::start(listen::Mode::Idle, listen::update, listen::work, Record(log.clone()));
    machine.send(listen::Ev::GoTwice);
    tokio::time::sleep(MOMENT).await;
    assert_eq!(seen(&log), [listen::Fx::Listen(1), listen::Fx::Listen(1), listen::Fx::Listen(2)], "two first listeners");
}

// ---------------------------------------------------------------- the order of a step

#[tokio::test(start_paused = true)]
async fn a_step_hands_over_updates_effects_then_the_new_work_each_in_the_order_listed() {
    let log = Seen::default();
    let machine = Runtime::start(listen::Mode::Idle, listen::update, listen::work, Record(log.clone()));
    machine.send(listen::Ev::Go);
    tokio::time::sleep(MOMENT).await;
    let order = [listen::Fx::Kick(1), listen::Fx::Kick(2), listen::Fx::Listen(1), listen::Fx::Listen(2)];
    assert_eq!(seen(&log), order);
}

// ---------------------------------------------------------------- work is its own key, and is never stopped

#[tokio::test(start_paused = true)]
async fn owed_work_starts_once_and_new_work_starts_without_stopping_the_old() {
    let log = Seen::default();
    let machine = Runtime::start(1, counter::update, counter::work, counter::Writer(log.clone()));
    tokio::time::sleep(MOMENT).await;
    machine.send(counter::Ev::Set(1)); // a change to an equal state: it needs the same Write(1)
    machine.send(counter::Ev::Set(3)); // another value is other work
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(seen(&log), [counter::Fx::Write(1), counter::Fx::Write(3)]);
}

#[tokio::test(start_paused = true)]
async fn the_result_of_work_no_longer_needed_still_arrives() {
    let log = Seen::default();
    let machine = Runtime::start(1, counter::update, counter::work, counter::Writer(log.clone()));
    tokio::time::sleep(Duration::from_millis(10)).await;
    machine.send(counter::Ev::Set(2)); // 2 needs nothing: Write(1), 50 ms long, is no longer needed
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(machine.state().borrow().value, 1002, "Done(1) arrived after the state stopped needing it");
    assert_eq!(seen(&log), [counter::Fx::Write(1)]);
}

// ---------------------------------------------------------------- timers

#[tokio::test(start_paused = true)]
async fn a_timer_is_stopped_when_the_machine_leaves_its_state() {
    let machine = Runtime::start(wait::Wait::Armed, wait::update, wait::work, wait::free());
    tokio::time::sleep(MOMENT).await;
    assert_eq!(alive_tasks(), 2, "the machine and its timer");
    machine.send(wait::Ev::Leave);
    tokio::time::sleep(MOMENT).await;
    assert_eq!(alive_tasks(), 1, "the timer of the state left is stopped");
    tokio::time::sleep(HOUR).await;
    assert_eq!(machine.state().borrow().value, wait::Wait::Left);
}

/// The state is left while its timer fires: the firing queues up behind the
/// event that left it, and is dropped. Real threads, so the timer can fire
/// while the machine's task is held; each step waits for its signal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timer_that_fires_while_its_state_is_being_left_is_dropped() {
    let (release, released) = std_mpsc::channel();
    let log = Seen::default();
    let machine = Runtime::start(wait::Wait::Armed, wait::update, wait::work, wait::Gate(Some(released), log.clone()));
    let checked = || seen(&log).iter().filter(|fx| **fx == wait::Fx::Checked).count();
    machine.send(wait::Ev::Check);
    until("the machine has armed its timer", || checked() == 1).await;
    // tokio keeps a task just spawned in its spawner's LIFO slot, which no
    // other worker can take: let the idle worker give the timer its first
    // poll before the gate holds that worker.
    tokio::time::sleep(Duration::from_millis(10)).await;
    machine.send(wait::Ev::Leave); // its Slow holds the machine's task before Armed's timer is stopped
    let states = machine.state();
    until("Left is out, and its Slow holds the machine", || states.borrow().value == wait::Wait::Left).await;
    until("the timer fired, behind Leave", || alive_tasks() == 1).await;
    release.send(()).expect("the gate");
    machine.send(wait::Ev::Check);
    until("the fence was handled", || checked() == 2).await;
    assert_eq!(machine.state().borrow().value, wait::Wait::Left, "the firing was dropped");
}

#[tokio::test(start_paused = true)]
async fn a_timer_counts_from_when_its_state_needs_it() {
    #[derive(Clone, Debug, PartialEq)]
    enum Ev {
        Fire,
    }
    #[derive(Clone, Debug, PartialEq)]
    enum Fx {
        Pause,
    }
    fn update(_: &bool, Ev::Fire: Ev) -> Next<bool, Fx> {
        to(true)
    }
    /// The timer, then work that holds the only thread while ten seconds pass.
    fn work(fired: &bool) -> Owed<Fx, Ev> {
        match fired {
            false => Owed::nothing().after(SECOND, Ev::Fire).run(Fx::Pause),
            true => Owed::nothing(),
        }
    }
    struct Pausing;
    impl Effects<Fx, Ev> for Pausing {
        fn run(&mut self, Fx::Pause: Fx, _: &Events<Ev>) {
            // A long pause before the timer's task first runs: the paused clock
            // moves on while this handler holds the only thread.
            let mut pause = std::pin::pin!(tokio::time::advance(10 * SECOND));
            let _ = pause.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        }
    }
    let armed = tokio::time::Instant::now();
    let machine = Runtime::start(false, update, work, Pausing);
    let mut states = machine.state();
    states.wait_for(|at| at.value).await.expect("the machine");
    assert_eq!(armed.elapsed(), 10 * SECOND, "due at 1 s, it fired as soon as its task ran");
}

// ---------------------------------------------------------------- the state stream

#[tokio::test(start_paused = true)]
async fn the_state_stream_keeps_the_latest_state_and_a_fact_that_stays_true() {
    let machine = Runtime::start(0, counter::update, counter::work, Record(Seen::default()));
    let mut states = machine.state();
    for n in [2, 4, 6, 8] {
        machine.send(counter::Ev::Set(n));
    }
    let fact = states.wait_for(|at| at.value >= 4).await.expect("the machine").clone();
    assert_eq!(fact, At { version: 4, value: 8 }, "the states between are not kept; the fact still holds");
}

mod watcher {
    //! A machine that waits for a fact in another machine's state.
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    pub enum Watch {
        Idle,
        Waiting,
        Saw,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Ev {
        Watch,
        Seen,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub enum Fx {
        AwaitTen,
    }

    pub fn update(watch: &Watch, event: Ev) -> Next<Watch, Fx> {
        match (watch, event) {
            (Watch::Idle, Ev::Watch) => to(Watch::Waiting),
            (Watch::Waiting, Ev::Seen) => to(Watch::Saw),
            (Watch::Waiting | Watch::Saw, Ev::Watch) | (Watch::Idle | Watch::Saw, Ev::Seen) => stay(),
        }
    }
    pub fn work(watch: &Watch) -> Owed<Fx, Ev> {
        match watch {
            Watch::Waiting => Owed::nothing().run(Fx::AwaitTen),
            Watch::Idle | Watch::Saw => Owed::nothing(),
        }
    }

    /// Waits on the other machine's state for a fact that stays true.
    pub struct Other(pub watch::Receiver<At<u32>>);
    impl Effects<Fx, Ev> for Other {
        fn run(&mut self, Fx::AwaitTen: Fx, events: &Events<Ev>) {
            let mut other = self.0.clone();
            events.spawn(async move {
                other.wait_for(|at| at.value >= 10).await.ok()?;
                Some(Ev::Seen)
            });
        }
    }
}

#[tokio::test(start_paused = true)]
async fn one_machine_learns_about_another_from_its_state() {
    let counter = Runtime::start(0, counter::update, counter::work, Record(Seen::default()));
    let watcher = Runtime::start(watcher::Watch::Idle, watcher::update, watcher::work, watcher::Other(counter.state()));
    watcher.send(watcher::Ev::Watch);
    tokio::time::sleep(MOMENT).await;
    assert_eq!(watcher.state().borrow().value, watcher::Watch::Waiting);
    counter.send(counter::Ev::Set(4));
    counter.send(counter::Ev::Set(12));
    tokio::time::sleep(MOMENT).await;
    assert_eq!(watcher.state().borrow().value, watcher::Watch::Saw);
}

// ---------------------------------------------------------------- when the machine is gone

#[tokio::test(start_paused = true)]
async fn when_the_machine_panics_its_state_stream_ends_and_its_timers_stop() {
    fn broken(_: &wait::Wait, _: wait::Ev) -> Next<wait::Wait, wait::Fx> {
        panic!("a bug in update")
    }
    let machine = Runtime::start(wait::Wait::Armed, broken, wait::work, wait::free());
    let mut states = machine.state();
    tokio::time::sleep(MOMENT).await;
    assert_eq!(alive_tasks(), 2, "the machine and its timer");
    machine.send(wait::Ev::Check);
    assert!(states.changed().await.is_err(), "whoever waits is told");
    tokio::time::sleep(MOMENT).await;
    assert_eq!(alive_tasks(), 0, "its timer stopped with it");
}

#[tokio::test(start_paused = true)]
async fn a_machine_ends_with_its_last_handle_and_the_others_go_on() {
    let kept = Runtime::start(1, counter::update, counter::work, counter::Writer(Seen::default()));
    let dropped = Runtime::start(0, counter::update, counter::work, Record(Seen::default()));
    let last = dropped.clone();
    let mut states = dropped.state();
    drop(dropped);
    last.send(counter::Ev::Set(2)); // one handle is left: the machine still runs
    states.changed().await.expect("still running");
    assert_eq!(states.borrow_and_update().value, 2);
    drop(last);
    assert!(states.changed().await.is_err(), "the last handle is gone, and the stream ended");
    tokio::time::sleep(SECOND).await;
    assert_eq!(kept.state().borrow().value, 1002, "the other machine went on: its write came back");
}

#[tokio::test(start_paused = true)]
async fn events_do_not_keep_a_machine_alive_and_say_when_it_is_gone() {
    struct Keep(Arc<Mutex<Option<Events<counter::Ev>>>>);
    impl Effects<counter::Fx, counter::Ev> for Keep {
        fn run(&mut self, _: counter::Fx, events: &Events<counter::Ev>) {
            *self.0.lock().unwrap() = Some(events.clone());
        }
    }
    let kept = Arc::default();
    let machine = Runtime::start(2, counter::update, counter::work, Keep(Arc::clone(&kept)));
    machine.send(counter::Ev::Ping(1));
    tokio::time::sleep(MOMENT).await;
    let events = kept.lock().unwrap().clone().expect("the handler was handed Pong");
    assert!(events.send(counter::Ev::Ping(2)), "the machine runs");
    drop(machine);
    assert!(!events.send(counter::Ev::Ping(3)), "the machine is gone");
}

// ---------------------------------------------------------------- no recovery

#[tokio::test(start_paused = true)]
async fn work_that_panics_sends_nothing_and_the_machine_goes_on() {
    struct Failing(Seen<counter::Fx>);
    impl Effects<counter::Fx, counter::Ev> for Failing {
        fn run(&mut self, effect: counter::Fx, events: &Events<counter::Ev>) {
            self.0.lock().unwrap().push(effect.clone());
            if let counter::Fx::Write(n) = effect {
                events.spawn(async move {
                    tokio::time::sleep(MOMENT).await;
                    panic!("write {n} failed")
                });
            }
        }
    }
    let log = Seen::default();
    let machine = Runtime::start(1, counter::update, counter::work, Failing(log.clone()));
    tokio::time::sleep(SECOND).await;
    assert_eq!(*machine.state().borrow(), At { version: 0, value: 1 }, "nothing came back");
    machine.send(counter::Ev::Ping(5));
    tokio::time::sleep(MOMENT).await;
    assert_eq!(seen(&log), [counter::Fx::Write(1), counter::Fx::Pong(5)], "the machine still answers");
}

// ---------------------------------------------------------------- where a machine starts

#[test]
#[should_panic(expected = "there is no reactor running")]
fn starting_a_machine_outside_a_tokio_runtime_panics() {
    let _machine = Runtime::start(0, counter::update, counter::work, Record(Seen::default()));
}

#[test]
fn with_a_runtime_entered_a_machine_starts_and_send_needs_no_runtime() {
    let tokio = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("a runtime");
    let machine = {
        let _entered = tokio.enter();
        Runtime::start(0, counter::update, counter::work, Record(Seen::default()))
    };
    machine.send(counter::Ev::Set(4)); // from plain synchronous code, as a command would
    let mut states = machine.state();
    let state = tokio.block_on(states.wait_for(|at| at.value == 4)).expect("the machine").clone();
    assert_eq!(state, At { version: 1, value: 4 });
}

#[test]
fn a_machine_whose_state_needs_a_timer_needs_the_time_driver() {
    let tokio = tokio::runtime::Builder::new_current_thread().build().expect("a runtime with no timers");
    let machine = {
        let _entered = tokio.enter();
        Runtime::start(wait::Wait::Armed, wait::update, wait::work, wait::free())
    };
    let mut states = machine.state();
    // On its own thread, so a machine that does not end fails the test instead of hanging it.
    let (ended, end) = std_mpsc::channel();
    std::thread::spawn(move || ended.send(tokio.block_on(states.changed()).is_err()));
    assert_eq!(end.recv_timeout(10 * SECOND), Ok(true), "it panicked arming its timer, and its stream ended");
    drop(machine);
}
