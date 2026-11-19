# keepdeck-fsm

The domain logic of a KeepDeck feature, written as a state machine: two pure
functions over the feature's own types. This crate is what a feature writes its
rules against, and it has no dependencies. Running a machine — its task, its
timers, the handler that touches the world, the stream of its states — is
`keepdeck-fsm-runtime` (`crates/keepdeck-fsm-runtime`).

## What it is for

The rules of one feature: what happens to its state on each event, and what
each state needs while the machine is in it. One machine per feature.

A feature has levels, and each owns its own part:

| Level | Owns | Lives in |
|---|---|---|
| The machine | The feature's rules. It hands over kinds and data, never wording | A Rust crate, written against this one |
| The runtime and the feature's handler | IO: processes, files, the network, the answer to whoever asked | The app (`src-tauri`) |
| A UI object | UI decisions: what to show, in what order, with what words | TypeScript presentation |
| Components | Rendering | TypeScript components |

## When not to use it

- For UI decisions. They belong to a presentation object, not to a machine.
- For recovery after a failure. The framework recovers nothing; a feature that
  needs recovery makes the failure an event of its own and writes the rule for it.
- For logic with no state over time. A pure function is enough.
- Nothing of a particular feature goes into this crate: no feature's events,
  effects or rules.

## Three types and two functions

A feature defines three types of its own and two plain functions. There is no
trait to implement:

```text
State   what the feature knows now
Event   what happened: a request, the result of some work, a timer
Effect  what the feature's handler does in the world

fn update(&State, Event) -> Next<State, Effect>   the new state if it changes, and effects done once
fn work(&State) -> Owed<Effect, Event>            what the state needs while the machine is in it
```

`Event` and `Effect` derive `Clone` and `PartialEq`: the runtime keeps a copy
of each piece of work to recognise it in the next state.

**`update` or `work`?** Ask: *if the machine were started directly in this
state, must this be done?* Yes — it is work, listed by `work`. No — it happens
because of the event, and `update` asks for it. The two differ by what starts
them, not by how long they live: work from `work` is also done once.

- `update` answers an event with `to(state)` or `stay()`, then `.run(effect)`
  for each effect to do once. An event may change nothing and still do
  something: `stay().run(effect)`. The answer to whoever sent a request is
  such an effect.
- `work` lists what a state needs: `Owed::nothing()`, then `.run(effect)` and
  `.after(delay, event)`. On each change of state the runtime starts the work
  that is new and drops the timers the new state no longer needs. A machine
  started in a state — after a restart, say — does that state's work again.

## An example

Uploads, each tried up to three times with a pause between attempts. One upload
is one entity; the result of an attempt names its upload and its attempt.

```rust
use keepdeck_fsm::{stay, to, Next, Owed};
use std::collections::BTreeMap;
use std::time::Duration;

type Id = u32;

#[derive(Clone, Debug, PartialEq)]
enum Upload {
    Sending { attempt: u32 },
    Waiting { attempt: u32 },
    Done,
    GaveUp,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct State(BTreeMap<Id, Upload>);

#[derive(Clone, Debug, PartialEq)]
enum Event {
    Start(Id),
    /// The result of `Effect::Send`: the upload, the attempt, whether it went through.
    Sent(Id, u32, bool),
    /// The pause after a failed attempt is over.
    Retry(Id),
}

#[derive(Clone, Debug, PartialEq)]
enum Effect {
    Send(Id, u32),
    /// Tell whoever started the upload how it ended.
    Report(Id, bool),
}

const PAUSE: Duration = Duration::from_secs(5);
const ATTEMPTS: u32 = 3;

impl Event {
    fn upload(&self) -> Id {
        match *self {
            Event::Start(id) | Event::Sent(id, ..) | Event::Retry(id) => id,
        }
    }
}

/// Find the upload, apply its table, write it back.
fn update(state: &State, event: Event) -> Next<State, Effect> {
    let id = event.upload();
    let (upload, effect) = step(id, state.0.get(&id), event);
    let next = match upload {
        Some(upload) => {
            let mut next = state.clone();
            next.0.insert(id, upload);
            to(next)
        }
        None => stay(),
    };
    match effect {
        Some(effect) => next.run(effect),
        None => next,
    }
}

/// The rules of one upload: one line per transition that does something.
fn step(id: Id, upload: Option<&Upload>, event: Event) -> (Option<Upload>, Option<Effect>) {
    use Upload::{Done, GaveUp, Sending, Waiting};
    match (upload, event) {
        (None | Some(Done | GaveUp), Event::Start(_)) => (Some(Sending { attempt: 1 }), None),
        (Some(&Sending { attempt }), Event::Sent(_, of, true)) if of == attempt => {
            (Some(Done), Some(Effect::Report(id, true)))
        }
        (Some(&Sending { attempt }), Event::Sent(_, of, false)) if of == attempt && attempt == ATTEMPTS => {
            (Some(GaveUp), Some(Effect::Report(id, false)))
        }
        (Some(&Sending { attempt }), Event::Sent(_, of, false)) if of == attempt => (Some(Waiting { attempt }), None),
        (Some(&Waiting { attempt }), Event::Retry(_)) => (Some(Sending { attempt: attempt + 1 }), None),
        // Everything else changes nothing: a start while busy, the result of an
        // older attempt, a late timer. The events are named, so a new event
        // does not compile until it is placed in this table.
        (_, Event::Start(_) | Event::Sent(..) | Event::Retry(_)) => (None, None),
    }
}

/// What each upload needs while it is at its stage.
fn work(state: &State) -> Owed<Effect, Event> {
    state.0.iter().fold(Owed::nothing(), |owed, (&id, upload)| match *upload {
        Upload::Sending { attempt } => owed.run(Effect::Send(id, attempt)),
        Upload::Waiting { .. } => owed.after(PAUSE, Event::Retry(id)),
        Upload::Done | Upload::GaveUp => owed,
    })
}

// The rules, tested as plain functions, with no runtime.
let sending = State([(7, Upload::Sending { attempt: 1 })].into());
assert_eq!(update(&State::default(), Event::Start(7)), to(sending.clone()));
assert_eq!(work(&sending), Owed::nothing().run(Effect::Send(7, 1)));

// A failed attempt waits, then tries again: a new attempt is new work.
let waiting = State([(7, Upload::Waiting { attempt: 1 })].into());
assert_eq!(update(&sending, Event::Sent(7, 1, false)), to(waiting.clone()));
assert_eq!(work(&waiting), Owed::nothing().after(PAUSE, Event::Retry(7)));
let again = State([(7, Upload::Sending { attempt: 2 })].into());
assert_eq!(update(&waiting, Event::Retry(7)), to(again.clone()));
assert_eq!(work(&again), Owed::nothing().run(Effect::Send(7, 2)));

// The report is done once, because of the event; a finished upload needs nothing.
let done = State([(7, Upload::Done)].into());
assert_eq!(update(&sending, Event::Sent(7, 1, true)), to(done.clone()).run(Effect::Report(7, true)));
assert_eq!(work(&done), Owed::nothing());

// The result of an older attempt changes nothing.
assert_eq!(update(&again, Event::Sent(7, 1, true)), stay());
```

### The table

When every event names one entity and a transition changes only that entity,
a feature may write its rules as a table for one entity, like `step` above: one
line per transition that does something, and a last line for everything that
changes nothing. `update` then only finds the entity, applies the table and
writes the result back. Without the table, `update` grows: the lookup repeats
in every branch, and "nothing" is spelled out for every event.

The last line names the events and leaves only the entity open:
`(_, Event::Start(_) | Event::Sent(..) | Event::Retry(_))`. A new event then
does not compile (E0004) until it is placed in the table, where a plain `_`
would compile and quietly change nothing. The table does not flag a new stage
of the entity — `work` matches every stage, so the compiler flags it there —
and tests do not always catch a missing line: that is the price of the short
table.

A feature whose events do not fit — an event that names no entity, a transition
that changes more than one — writes `update` as a plain `match`.

## Rules for the author

What the runtime does with a machine — the timers, the order of a step, the
state stream, what happens when it is gone — is in the README of
`keepdeck-fsm-runtime`, each rule with its test. These are the rules that
shape `update` and `work`:

| Rule | Why | Held by |
|---|---|---|
| Ask "if the machine were started in this state, must this be done?" Yes — `work`; no — `update` | Work a state needs is done whenever the machine is in it, including on a start; an effect of an event is done once, for that event | runtime `a_machine_started_in_a_state_does_its_work`, `an_event_that_changes_no_state_still_does_its_effect_once` |
| An effect comes from one path: from `update` or from `work`, never both | If a transition asks for an effect and the state it enters needs the same one, it is handed over twice in one step | runtime `the_same_effect_from_both_paths_is_handed_over_twice` |
| The value of a piece of work is its key: it names its owner and its attempt, and holds exactly what makes it different | While a state keeps needing an equal value, the work is not started again. Without the owner, the same work of two owners merges into one; without the attempt, a retry never runs | `listing_the_same_work_twice_owes_it_once`, `work_that_differs_in_anything_is_other_work`; runtime `owed_work_starts_once_and_new_work_starts_without_stopping_the_old` |
| Work survives being done again | A machine started in a state does that state's work again, whatever was done before | runtime `a_machine_started_in_a_state_does_its_work` |
| The result of work names its owner and its attempt, and `update` checks them | Work is never stopped, so its result can arrive after the state that needed it is gone | runtime `the_result_of_work_no_longer_needed_still_arrives` |

## Testing a feature

`update` and `work` are plain functions: test them with no runtime, as the
example does. Each rule gets a test that goes red when the rule is broken.

Timing — a timer, a result that arrives late, the order of a step — is tested
on the runtime under tokio's paused time; the README of
`keepdeck-fsm-runtime` says how. A feature takes the runtime as a
dev-dependency only, so the runtime stays out of the feature's own build.

```sh
cargo test -p keepdeck-fsm
```
