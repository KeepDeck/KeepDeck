//! The names the lifecycle gives and keeps.
//!
//! Workspace and team ids are random tokens, drawn by the door that sends the
//! intent: `update` is pure and cannot draw one, and a counter in the state
//! would hand an id out again after a restart. Pane, operation, permit and
//! attempt numbers are counters in the machine's state that only grow within
//! a launch; the pane and operation counters are seeded at boot above every
//! number the deck and the journal still hold.

use serde::{Deserialize, Serialize};
use std::fmt;

/// `ws-` and a random token; older decks hold `ws-N`, which stays valid.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkspaceId(pub String);

/// `team-` and a random token; older decks hold `team-N`, which stays valid.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TeamId(pub String);

/// A pane, `pane-N` on the deck. N is never issued twice in one launch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub struct PaneId(pub u64);

const PANE_PREFIX: &str = "pane-";

impl fmt::Display for PaneId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{PANE_PREFIX}{}", self.0)
    }
}

impl From<PaneId> for String {
    fn from(id: PaneId) -> String {
        id.to_string()
    }
}

impl TryFrom<String> for PaneId {
    type Error = String;

    fn try_from(text: String) -> Result<Self, String> {
        PaneId::parse(&text).ok_or_else(|| format!("not a pane id: {text:?}"))
    }
}

impl PaneId {
    /// The pane a deck id names, or `None` for anything that is not `pane-N`.
    pub fn parse(text: &str) -> Option<PaneId> {
        let digits = text.strip_prefix(PANE_PREFIX)?;
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        digits.parse().ok().map(PaneId)
    }
}

/// One operation of the machine; its journal entry is `op-N.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OpId(pub u64);

impl fmt::Display for OpId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "op-{}", self.0)
    }
}

/// The exact name of one command to a data owner: its operation and its
/// place among that operation's commands. Two commands of one kind never
/// share it, and a restored operation asks again under the same names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct CommandId {
    pub op: OpId,
    pub index: u32,
}

/// A launch permit: one owner, one target, spent by one admission.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermitId(pub u64);

/// An admitted launch attempt — what the spawn door's start boundary keys on,
/// and the id a session carries back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AttemptId(pub u64);

/// A counter that only grows: what mints pane, operation, permit and attempt
/// numbers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counter(u64);

impl Counter {
    /// A counter whose first number is above every one in `taken`.
    pub fn above(taken: impl IntoIterator<Item = u64>) -> Counter {
        Counter(taken.into_iter().max().map_or(1, |max| max + 1))
    }

    /// The next number, and the counter past it.
    pub fn next(self) -> (u64, Counter) {
        (self.0, Counter(self.0 + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pane_id_reads_and_writes_as_the_deck_spells_it() {
        assert_eq!(PaneId(12).to_string(), "pane-12");
        assert_eq!(PaneId::parse("pane-12"), Some(PaneId(12)));
        assert_eq!(serde_json::to_string(&PaneId(3)).unwrap(), "\"pane-3\"");
        assert_eq!(serde_json::from_str::<PaneId>("\"pane-3\"").unwrap(), PaneId(3));
    }

    #[test]
    fn anything_but_pane_and_digits_is_not_a_pane_id() {
        for text in ["pane-", "pane-1a", "pane--1", "Pane-1", "p1", "pane- 1", "pane-+1"] {
            assert_eq!(PaneId::parse(text), None, "{text:?}");
        }
        assert!(serde_json::from_str::<PaneId>("\"team-1\"").is_err());
    }

    #[test]
    fn a_counter_starts_above_everything_taken_and_only_grows() {
        assert_eq!(Counter::above([]).next().0, 1);
        let counter = Counter::above([4, 9, 2]);
        let (first, counter) = counter.next();
        let (second, _) = counter.next();
        assert_eq!((first, second), (10, 11));
    }
}
