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
  synchronous code. `send` needs no runtime: a synchronous command may call it.
- The machine starts in `initial` and first does the work `initial` needs. A
  machine restored after a restart does the work of its restored state again.
- One machine per feature. Handles are cheap to clone. The machine ends when
  the last handle is dropped, so whoever owns the feature's lifetime owns a
  handle, and letting go of it is the stop.

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
the changes since the start, and moves only when the state changes.

The stream keeps only the latest state, so a reader may miss the states in
between. A fact that stays true once it is true cannot be missed: wait for
the fact (`wait_for`), not for a change. Another feature that needs to know
about this one looks for such a fact in its state; the machine has no other
output. A reader that also fetches the state another way — a UI that
subscribes and then asks by a command — keeps the copy with the higher
version.

When the machine's task is gone — the last handle dropped, or a panic — the
stream ends, and whoever waits on it is told.

## An example

A fetch with a deadline: the state needs the request sent and a timer, and
whichever comes first wins. The handler fakes the network with a delay.

```rust
use keepdeck_fsm::{stay, to, Next, Owed};
use keepdeck_fsm_runtime::{Effects, Events, Runtime};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
enum State {
    Idle,
    Fetching { request: u32 },
    Got(String),
    TimedOut,
}

#[derive(Clone, Debug, PartialEq)]
enum Event {
    Fetch(u32),
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
        (State::Fetching { .. }, Event::Fetch(_)) => stay(),
        (State::Idle | State::Got(_) | State::TimedOut, Event::Fetch(request)) => to(State::Fetching { request }),
        (State::Fetching { request }, Event::Fetched(of, body)) if *request == of => to(State::Got(body)),
        (State::Fetching { request }, Event::Deadline(of)) if *request == of => to(State::TimedOut),
        // A late answer or a stale deadline changes nothing.
        (_, Event::Fetched(..) | Event::Deadline(_)) => stay(),
    }
}

fn work(state: &State) -> Owed<Effect, Event> {
    match *state {
        State::Fetching { request } => Owed::nothing().run(Effect::Get(request)).after(DEADLINE, Event::Deadline(request)),
        State::Idle | State::Got(_) | State::TimedOut => Owed::nothing(),
    }
}

/// The handler. Here the network answers after `delay`.
struct Network {
    delay: Duration,
}

impl Effects<Effect, Event> for Network {
    fn run(&mut self, Effect::Get(request): Effect, events: &Events<Event>) {
        let delay = self.delay;
        events.spawn(async move {
            tokio::time::sleep(delay).await;
            Some(Event::Fetched(request, format!("body {request}")))
        });
    }
}

// Paused time: the timers run at once, and the test is exact.
#[tokio::main(flavor = "current_thread", start_paused = true)]
async fn main() {
    // A quick answer beats the deadline.
    let quick = Runtime::start(State::Idle, update, work, Network { delay: Duration::from_secs(1) });
    quick.send(Event::Fetch(1));
    let mut states = quick.state();
    let got = states.wait_for(|at| matches!(at.value, State::Got(_))).await.expect("the machine").clone();
    assert_eq!(got.value, State::Got("body 1".into()));
    assert_eq!(got.version, 2, "Idle, then Fetching, then Got");

    // A slow one loses to the deadline, and its late answer changes nothing.
    let slow = Runtime::start(State::Idle, update, work, Network { delay: Duration::from_secs(60) });
    slow.send(Event::Fetch(2));
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(slow.state().borrow().value, State::TimedOut);
}
```

## Rules

Each rule has a test in `tests/rules.rs`, named after it. The rules for
writing `update` and `work` are in the README of `keepdeck-fsm`.

| Rule | Why | Test |
|---|---|---|
| A step hands over `update`'s effects in the order listed, then the new work the state needs, in the order listed. "Started earlier" gives order; "finished earlier" holds only by cause | The hand-over is synchronous so that the order holds; the work finishes asynchronously | `a_step_hands_over_updates_effects_then_the_new_work_each_in_the_order_listed` |
| An event may change no state and still do its effects; the version moves only with a change | A command that does something without changing anything needs no fake state | `an_event_that_changes_no_state_still_does_its_effect_once` |
| A machine started in a state does that state's work | Whatever the state needs is done whenever the machine is in it, a restart included | `a_machine_started_in_a_state_does_its_work` |
| Work is started once while an equal piece is owed; new work starts without stopping the old | A piece of work's value is its key | `owed_work_starts_once_and_new_work_starts_without_stopping_the_old` |
| Work is never stopped, even when no state needs it any more; its result, if it has one, still arrives | Some work cannot be stopped halfway | `the_result_of_work_no_longer_needed_still_arrives` |
| A timer is dropped when the machine leaves the states that need it; its event arrives only if its arming is the current one | A firing can queue up behind the event that left its state, and a state entered again arms a new timer | `a_timer_is_dropped_when_the_machine_leaves_its_state`, `a_timer_that_fires_while_its_state_is_being_left_is_dropped`, `a_stale_timer_is_dropped_while_the_same_timer_is_needed_again` |
| The state stream keeps only the latest state; a fact that stays true is not missed | The stream is "how things are now", not a log of changes | `the_state_stream_keeps_the_latest_state_and_a_fact_that_stays_true` |
| Outside sees only the state. Effects go to the handler only; another feature learns about this one from its state | One output: nothing needs a second stream | `one_machine_learns_about_another_from_its_state` |
| The machine's task owns the state stream: when the task is gone, the stream ends, and the other machines go on. `Events` do not keep a machine alive | Otherwise whoever waits would wait for ever | `when_the_machine_panics_its_state_stream_ends`, `a_machine_ends_with_its_last_handle_and_the_others_go_on`, `events_do_not_keep_a_machine_alive_and_say_when_it_is_gone` |
| The framework recovers nothing. Work that fails or panics sends nothing; a feature that must know turns the failure into an event of its own. A panic in the machine is the app's concern | Recovery belongs to the feature that needs it, not to every feature | `work_that_panics_sends_nothing_and_the_machine_goes_on` |
| `start` needs an entered tokio runtime; `send` needs none | The machine is a tokio task; a command may be synchronous | `starting_a_machine_outside_a_tokio_runtime_panics`, `with_a_runtime_entered_a_machine_starts_and_send_needs_no_runtime` |

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
