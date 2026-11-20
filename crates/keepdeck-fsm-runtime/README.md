# keepdeck-fsm-runtime

Runs a machine written against `keepdeck-fsm` (`crates/keepdeck-fsm`): on a
tokio task of its own, with the feature's handler, its timers and the stream
of its states. A feature's rules do not depend on this crate. The app that
starts the machine depends on it, and so does a feature's timing tests, as a
dev-dependency.

What a machine is, and how to write `update` and `work`, is in the README of
`keepdeck-fsm`.

## When not to use it

- In a feature's own build. The feature's rules depend on `keepdeck-fsm`
  only; the runtime is a dev-dependency there, for timing tests.
- To test rules. `update` and `work` are plain functions, tested with no
  runtime.
- Where no tokio runtime is entered. `start` spawns the machine's task, so it
  belongs inside the app's async runtime.

What a machine itself is not for — UI decisions, recovery after a failure —
is in the README of `keepdeck-fsm`.

## Starting a machine

```text
Runtime::start(initial, update, work, handler) -> Runtime<State, Event>
machine.send(event)       an event, from anywhere; needs no tokio runtime
machine.state()           the stream of states: At { version, value }
```

- Call `start` where a tokio runtime is entered — in the app, inside its async
  runtime. The machine is a tokio task, so `start` panics from plain
  synchronous code. A machine whose states need timers also needs that
  runtime's time driver: without it, the machine panics when it arms its
  first timer. `send` needs no runtime: a synchronous command may call it.
- The machine starts in `initial` and first does the work `initial` needs. A
  machine restored after a restart does the work of its restored state again.
- One machine per feature. Handles are cheap to clone. Whoever owns the
  feature's lifetime owns a handle, and dropping the last one is the stop:
  the machine still handles what was sent before, then ends, and its state
  stream and timers end with it. An `Events::send` in the middle of its call
  holds the mailbox open until it returns, so sends that overlap the drop may
  still get in and stretch that drain.

## The handler

The handler is the feature's side that touches the world: processes, files,
the network, the answer to whoever asked. It implements one method:

```text
fn run(&mut self, effect: Effect, events: &Events<Event>)
```

It is handed every effect — first those `update` asked for, then the new work
the state needs, each in the order listed — on the machine's own task, one at
a time. So it must not block. Long work goes through `events.spawn`: the
future runs on its own task, and the event it returns, if any, comes back to
the machine. Work that keeps sending — a subscription — calls `events.send`
and stops when it returns false: the machine is gone.

A request that needs an answer gets it as an effect of the feature: `update`
asks for it, and the handler delivers it to whoever is waiting.

## The state stream

`state()` is a tokio `watch` of `At { version, value }`. The version counts
each new state `update` gave since this start — an equal one too — and does
not move when `update` keeps the state. A new start counts from 0 again, so
versions compare within one machine's life.

The stream keeps only the latest state, so a reader may miss the states in
between. A fact that stays true once it is true cannot be missed: wait for
the fact (`wait_for`), not for a change. Another feature that needs to know
about this one looks for such a fact in its state; the machine has no other
output. A reader that also fetches the state another way — a UI that
subscribes and then asks by a command — keeps the copy with the higher
version.

When the machine's task is gone — the last handle dropped, or a panic — the
stream ends, and whoever waits on it is told.

A borrow of the state — `borrow()`, or what `wait_for` returns — holds a lock
the machine needs to publish its next state. Copy out what you need and let
the borrow go before anything awaits: a reader that waits on the machine
while holding one waits for ever.

## An example

A fetch with a deadline: the state needs the request sent and a timer, and
whichever comes first wins. Each fetch gets the next request number, so an
answer names the fetch it belongs to, and a late one changes nothing. The
handler fakes the network with a delay.

```rust
use keepdeck_fsm::{stay, to, Next, Owed};
use keepdeck_fsm_runtime::{Effects, Events, Runtime};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
enum State {
    Idle,
    Fetching { request: u32 },
    Got { request: u32, body: String },
    TimedOut { request: u32 },
}

impl State {
    fn last_request(&self) -> u32 {
        match *self {
            State::Idle => 0,
            State::Fetching { request } | State::Got { request, .. } | State::TimedOut { request } => request,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Event {
    Fetch,
    Fetched(u32, String),
    Deadline(u32),
}

#[derive(Clone, Debug, PartialEq)]
enum Effect {
    Get(u32),
}

const DEADLINE: Duration = Duration::from_secs(10);

fn update(state: &State, event: Event) -> Next<State, Effect> {
    match (state, event) {
        (State::Fetching { .. }, Event::Fetch) => stay(),
        (State::Idle | State::Got { .. } | State::TimedOut { .. }, Event::Fetch) => {
            to(State::Fetching { request: state.last_request() + 1 })
        }
        (&State::Fetching { request }, Event::Fetched(of, body)) if of == request => to(State::Got { request, body }),
        (&State::Fetching { request }, Event::Deadline(of)) if of == request => to(State::TimedOut { request }),
        // The answer or the deadline of an earlier fetch changes nothing.
        (_, Event::Fetched(..) | Event::Deadline(_)) => stay(),
    }
}

fn work(state: &State) -> Owed<Effect, Event> {
    match *state {
        State::Fetching { request } => Owed::nothing().run(Effect::Get(request)).after(DEADLINE, Event::Deadline(request)),
        State::Idle | State::Got { .. } | State::TimedOut { .. } => Owed::nothing(),
    }
}

/// The handler. Here the network takes 15 s to answer the first fetch, and
/// 8 s after that.
struct Network;

impl Effects<Effect, Event> for Network {
    fn run(&mut self, Effect::Get(request): Effect, events: &Events<Event>) {
        let delay = Duration::from_secs(if request == 1 { 15 } else { 8 });
        events.spawn(async move {
            tokio::time::sleep(delay).await;
            Some(Event::Fetched(request, format!("body {request}")))
        });
    }
}

// Paused time: the timers run at once, and the test is exact.
#[tokio::main(flavor = "current_thread", start_paused = true)]
async fn main() {
    let machine = Runtime::start(State::Idle, update, work, Network);
    let mut states = machine.state();

    // The first fetch loses to its deadline, at 10 s.
    machine.send(Event::Fetch);
    states.wait_for(|at| at.value == State::TimedOut { request: 1 }).await.expect("the machine");

    // The second starts at once. At 15 s the first one's answer arrives, and
    // changes nothing.
    machine.send(Event::Fetch);
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(machine.state().borrow().value, State::Fetching { request: 2 });

    // At 18 s its own answer does. The state is copied out of the borrow.
    let got = states.wait_for(|at| matches!(at.value, State::Got { .. })).await.expect("the machine").clone();
    assert_eq!(got.value, State::Got { request: 2, body: "body 2".into() });
    assert_eq!(got.version, 4, "Fetching, TimedOut, Fetching, Got");
}
```

## Rules

Each rule has a test named after it, in `tests/rules.rs` — or in
`src/lib.rs` where the test builds the mailbox a race would leave, exactly,
instead of waiting for threads to race. The rules for writing `update` and `work`
are in the README of `keepdeck-fsm`.

| Rule | Why | Test |
|---|---|---|
| A step hands over `update`'s effects in the order listed, then the new work the state needs, in the order listed. "Started earlier" gives order; "finished earlier" holds only by cause | The hand-over is synchronous so that the order holds; the work finishes asynchronously | `a_step_hands_over_updates_effects_then_the_new_work_each_in_the_order_listed` |
| An event may change no state and still do its effects; the version moves only with a change | A command that does something without changing anything needs no fake state | `an_event_that_changes_no_state_still_does_its_effect_once` |
| A machine started in a state does that state's work | Whatever the state needs is done whenever the machine is in it, a restart included | `a_machine_started_in_a_state_does_its_work` |
| Work is started once while an equal piece is owed; new work starts without stopping the old | A piece of work's value is its key | `owed_work_starts_once_and_new_work_starts_without_stopping_the_old` |
| Work is never stopped, even when no state needs it any more; its result, if it has one, still arrives | Some work cannot be stopped halfway | `the_result_of_work_no_longer_needed_still_arrives` |
| A timer counts from when its state needs it. It is stopped when the machine leaves the states that need it, and its event arrives only if its arming is the current one | A firing can queue up behind the event that left its state, and a state entered again arms a new timer | `a_timer_counts_from_when_its_state_needs_it`, `a_timer_is_stopped_when_the_machine_leaves_its_state`, `a_timer_that_fires_while_its_state_is_being_left_is_dropped` and `a_stale_timer_is_dropped_while_the_same_timer_is_needed_again` (both `src/lib.rs`) |
| The state stream keeps only the latest state; a fact that stays true is not missed | The stream is "how things are now", not a log of changes | `the_state_stream_keeps_the_latest_state_and_a_fact_that_stays_true` |
| Outside sees only the state. Effects go to the handler only; another feature learns about this one from its state | One output: nothing needs a second stream | `one_machine_learns_about_another_from_its_state` |
| Dropping the last handle is the stop: what was sent before is still handled, then the machine ends. When its task is gone, by a panic too, its state stream ends and its timers stop; the other machines go on. `Events` do not keep a machine alive | Otherwise whoever waits would wait for ever, and a dead machine's timers would sleep on | `what_was_sent_before_the_last_handle_was_dropped_is_still_handled`, `a_machine_ends_with_its_last_handle_and_the_others_go_on`, `when_the_machine_panics_its_state_stream_ends_and_its_timers_stop`, `events_do_not_keep_a_machine_alive_and_say_when_it_is_gone` |
| The framework recovers nothing. Work that fails or panics sends nothing; a feature that must know turns the failure into an event of its own. A panic in the machine is the app's concern | Recovery belongs to the feature that needs it, not to every feature | `work_that_panics_sends_nothing_and_the_machine_goes_on` |
| `start` needs an entered tokio runtime, with its time driver if the states need timers; `send` needs none | The machine is a tokio task; a command may be synchronous. A missing time driver fails the machine, not quietly one deadline | `starting_a_machine_outside_a_tokio_runtime_panics`, `with_a_runtime_entered_a_machine_starts_and_send_needs_no_runtime`, `a_machine_whose_state_needs_a_timer_needs_the_time_driver` |

## Testing a feature's timing

A feature tests its rules as plain functions (see `keepdeck-fsm`). Timing — a
timer, an answer that comes late, the order of a step — is tested on this
runtime under tokio's paused time, as the example above does: timers fire at
once, in order, and the test is exact. A race — a firing that meets an event —
needs real threads: `#[tokio::test(flavor = "multi_thread")]`, run several
times.

The feature crate takes the runtime as a dev-dependency only, so it stays out
of the feature's own build:

```toml
[dev-dependencies]
keepdeck-fsm-runtime = { path = "../keepdeck-fsm-runtime" }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "test-util"] }
```

```sh
cargo test -p keepdeck-fsm-runtime
```
