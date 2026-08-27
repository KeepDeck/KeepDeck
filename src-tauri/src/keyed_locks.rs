//! The "one lock per key" idiom, extracted from its two hand copies.
//!
//! Two managed-state maps serialize whole critical sections by a natural key
//! — `git worktree add` per repository ([`crate::worktree`]`::RepoLocks`),
//! skills staging per workspace id ([`crate::skills`]`::SkillsLocks`) — and
//! the shape was written out twice: a shared map of per-key mutexes, the key
//! created on first use, and a poison policy applied identically at both
//! levels (taking the map's lock, taking the key's lock). This module owns
//! the shape once; the two named wrappers keep their own names, keys and
//! policies, because the policies are the part that must NOT merge:
//!
//! A worktree critical section mutates the repo's shared `.git` state. A
//! panic there leaves external state whose freshness the next lock holder
//! cannot prove, so silently re-sharing the lock would let a second agent
//! walk into a repo of unknown condition — hard failure surfaces it instead.
//! A staging critical section can only ever leave a `.tmp-<ws>` build dir
//! and an unpublished swap, both of which the next stage deletes and rebuilds
//! by design: the successor PROVES the state fresh, so recovery keeps the UI
//! alive at no risk. Unifying the policies would either hard-fail the UI on
//! a recoverable staging panic or silently share a possibly-corrupt repo —
//! there is no one policy that is right for both damage models.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

/// What a poisoned lock (a panic while it was held) costs the next taker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PoisonPolicy {
    /// Propagate the poison: `lock()` panics. For critical sections whose
    /// failure may have left shared external state no successor can verify.
    Hard,
    /// Recover the guard: the section runs again over state a successor
    /// rebuilds anyway. For critical sections whose leftovers are provably
    /// discarded by design.
    Recover,
}

impl PoisonPolicy {
    fn take<'a, T>(&self, lock: &'a Mutex<T>) -> MutexGuard<'a, T> {
        match self {
            PoisonPolicy::Hard => lock.lock().expect("keyed lock poisoned"),
            PoisonPolicy::Recover => lock.lock().unwrap_or_else(|p| p.into_inner()),
        }
    }
}

/// A map of per-key mutexes with one poison policy for both lock levels.
#[derive(Clone)]
pub(crate) struct KeyedLocks<K: Eq + std::hash::Hash + Clone> {
    inner: Arc<Mutex<HashMap<K, Arc<Mutex<()>>>>>,
    poison: PoisonPolicy,
}

impl<K: Eq + std::hash::Hash + Clone> KeyedLocks<K> {
    pub(crate) fn new(poison: PoisonPolicy) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            poison,
        }
    }

    /// The lock for `key`, created on first use. The caller decides WHEN the
    /// critical section runs (the handle is clonable and can move into a
    /// blocking task); [`Self::acquire`] decides HOW the lock is taken.
    pub(crate) fn for_key(&self, key: K) -> Arc<Mutex<()>> {
        let mut map = self.poison.take(self.inner.as_ref());
        map.entry(key).or_default().clone()
    }

    /// Take a key's lock under this map's poison policy — the second half of
    /// the idiom, so a policy cannot drift between the map and its keys.
    pub(crate) fn acquire<'a>(&self, lock: &'a Mutex<()>) -> MutexGuard<'a, ()> {
        self.poison.take(lock)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Holding two handles to one key must mean holding one mutex — the whole
    /// point of the map; a "lock per key" that handed out two mutexes would
    /// serialize nothing.
    #[test]
    fn one_key_hands_out_one_mutex() {
        let locks = KeyedLocks::<String>::new(PoisonPolicy::Recover);
        let first = locks.for_key("ws-1".into());
        let second = locks.for_key("ws-1".into());
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &locks.for_key("ws-2".into())));
    }

    /// A panicked holder poisons the key's mutex; the Recover policy takes it
    /// anyway — the successor rebuilds the section's state by design.
    #[test]
    fn recover_takes_a_poisoned_key_lock() {
        let locks = KeyedLocks::<String>::new(PoisonPolicy::Recover);
        let lock = locks.for_key("ws-1".into());
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock().unwrap();
            panic!("poison the held lock");
        }));
        let _guard = locks.acquire(&lock);
    }

    /// The same panic under the Hard policy surfaces instead — a successor
    /// that cannot verify the state must not walk in silently.
    #[test]
    #[should_panic(expected = "keyed lock poisoned")]
    fn hard_surfaces_a_poisoned_key_lock() {
        let locks = KeyedLocks::<String>::new(PoisonPolicy::Hard);
        let lock = locks.for_key("ws-1".into());
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock().unwrap();
            panic!("poison the held lock");
        }));
        let _guard = locks.acquire(&lock);
    }
}
