#![doc = include_str!("../README.md")]

use std::time::Duration;

/// What `update` decided for one event: maybe a new state, and effects to do
/// once, because of this event, in the order listed.
///
/// Built with [`to`] or [`stay`], then [`Next::run`] for each effect. An event
/// may change nothing and still do something: `stay().run(effect)`.
#[derive(Debug, PartialEq)]
pub struct Next<S, F> {
    /// The new state, or `None` when the event changes no state.
    pub state: Option<S>,
    /// Effects done once, in this order, before the new state's work starts.
    pub effects: Vec<F>,
}

/// The machine moves to `state`.
pub fn to<S, F>(state: S) -> Next<S, F> {
    Next { state: Some(state), effects: Vec::new() }
}

/// The machine keeps its state.
pub fn stay<S, F>() -> Next<S, F> {
    Next { state: None, effects: Vec::new() }
}

impl<S, F> Next<S, F> {
    /// Do `effect` once, because of this event, after the ones already listed.
    pub fn run(mut self, effect: F) -> Self {
        self.effects.push(effect);
        self
    }
}

/// One piece of work a state needs while the machine is in it.
///
/// Its value is its identity: while a state keeps needing an equal value, the
/// work is not started again. So the value names its owner and its attempt,
/// and holds exactly what makes one piece of work different from another.
#[derive(Clone, Debug, PartialEq)]
pub enum Work<F, E> {
    /// An effect for the feature's handler. Started once; never stopped, even
    /// when the state stops needing it, so its result still comes back.
    Run(F),
    /// A timer: `E` arrives after the delay, unless the machine leaves every
    /// state that needs this timer first.
    After(Duration, E),
}

/// Everything a state needs while the machine is in it, in the order new work
/// starts.
#[derive(Debug, PartialEq)]
pub struct Owed<F, E>(Vec<Work<F, E>>);

impl<F: PartialEq, E: PartialEq> Owed<F, E> {
    /// A state that needs nothing.
    pub fn nothing() -> Self {
        Owed(Vec::new())
    }

    /// The state needs `effect` done.
    pub fn run(self, effect: F) -> Self {
        self.with(Work::Run(effect))
    }

    /// The state needs `event` after `delay`, for as long as the machine stays.
    pub fn after(self, delay: Duration, event: E) -> Self {
        self.with(Work::After(delay, event))
    }

    /// The same work listed twice is needed once: it is one piece of work.
    fn with(mut self, work: Work<F, E>) -> Self {
        if !self.0.contains(&work) {
            self.0.push(work);
        }
        self
    }
}

/// The work in the order it was listed: the order the runtime starts it in.
impl<F, E> IntoIterator for Owed<F, E> {
    type Item = Work<F, E>;
    type IntoIter = std::vec::IntoIter<Work<F, E>>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn effects_keep_the_order_update_listed_them_in_with_or_without_a_new_state() {
        let moved: Next<u8, char> = to(1).run('a').run('b');
        assert_eq!(moved, Next { state: Some(1), effects: vec!['a', 'b'] });
        let stayed: Next<u8, char> = stay().run('b').run('a');
        assert_eq!(stayed, Next { state: None, effects: vec!['b', 'a'] });
    }

    #[test]
    fn work_keeps_the_order_it_was_listed_in() {
        let owed: Owed<char, u8> = Owed::nothing().after(SECOND, 1).run('b').run('a');
        let listed: Vec<_> = owed.into_iter().collect();
        assert_eq!(listed, [Work::After(SECOND, 1), Work::Run('b'), Work::Run('a')]);
    }

    #[test]
    fn listing_the_same_work_twice_owes_it_once() {
        let twice: Owed<char, u8> = Owed::nothing().run('a').after(SECOND, 1).run('a').after(SECOND, 1);
        assert_eq!(twice, Owed::nothing().run('a').after(SECOND, 1));
    }

    #[test]
    fn work_that_differs_in_anything_is_other_work() {
        let owed: Owed<char, u8> = Owed::nothing().after(SECOND, 1).after(2 * SECOND, 1).after(SECOND, 2);
        assert_eq!(owed.into_iter().count(), 3, "another delay, another event: three timers");
    }
}
