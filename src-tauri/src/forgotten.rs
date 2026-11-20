//! The commit gate: whether the workspace, team or pane a write comes from
//! is forgotten. A store asks at its commit, under its own lock, and refuses
//! the write when it is; the cleanup of whatever forgot them takes the same
//! lock. So a write already under the lock lands and is cleaned up after,
//! and the next one is refused — nothing is left behind and nothing comes
//! back.
//!
//! The stores know nothing of the lifecycle machine: they hold this port,
//! and the lifecycle answers through it. The answer is copied out and the
//! machine's state let go at once — no store lock waits on the machine.

use serde::Deserialize;
use std::sync::Arc;

/// Who a write comes from: its workspace and, when it has them, its team and
/// pane. Set by the app for the writer, never taken from the writer's own
/// words.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(rename = "workspaceId")]
    pub workspace: String,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub pane: Option<String>,
}

/// A write on behalf of a workspace as a whole.
impl From<&str> for Source {
    fn from(workspace: &str) -> Source {
        Source { workspace: workspace.to_owned(), team: None, pane: None }
    }
}

/// The answer behind the gate.
pub trait Forgetting: Send + Sync {
    fn forgotten(&self, source: &Source) -> bool;
}

/// A write refused at its commit: what it was for is forgotten. Never tried
/// again — there is nothing for it to land in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub workspace: String,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "what this write is for in workspace {} is closed; nothing more is written for it", self.workspace)
    }
}

#[derive(Clone)]
pub struct Gate {
    port: Arc<dyn Forgetting>,
}

impl Gate {
    pub fn new(port: impl Forgetting + 'static) -> Gate {
        Gate { port: Arc::new(port) }
    }

    /// Ask at the commit, under the store's lock.
    pub fn admit(&self, source: &Source) -> Result<(), Refused> {
        if self.port.forgotten(source) {
            return Err(Refused { workspace: source.workspace.clone() });
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! A gate whose forgotten set a test fills.

    use super::{Forgetting, Gate, Source};
    use std::collections::BTreeSet;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub struct Forget {
        names: Arc<Mutex<BTreeSet<String>>>,
    }

    impl Forget {
        /// Forget a workspace, team or pane by its id.
        pub fn forget(&self, id: &str) {
            self.names.lock().unwrap().insert(id.to_owned());
        }

        pub fn gate(&self) -> Gate {
            Gate::new(self.clone())
        }
    }

    impl Forgetting for Forget {
        fn forgotten(&self, source: &Source) -> bool {
            let names = self.names.lock().unwrap();
            names.contains(&source.workspace)
                || source.team.as_ref().is_some_and(|team| names.contains(team))
                || source.pane.as_ref().is_some_and(|pane| names.contains(pane))
        }
    }
}
