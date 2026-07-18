//! `keepdeck-git` — git worktree provisioning for KeepDeck agent isolation.
//!
//! Each agent runs in its own git worktree (its own branch + working directory,
//! sharing the repository's object store), so a fleet of agents can work the
//! same repo in parallel without colliding on files or git state.
//!
//! This crate is the domain layer: pure Rust with NO external crates and NO
//! Tauri dependency. It shells out to the user's `git` through a single IO
//! boundary (`run_git`) and keeps everything else — branch-name sanitization,
//! `--porcelain` parsing — as pure, unit-tested logic. Orchestration concerns
//! (per-repo locking, the agent→worktree registry, persistence, reconcile) live
//! in the delivery layer that consumes this crate, not here.

mod cmd;
mod error;

pub mod branch;
pub mod diff;
pub mod head;
pub mod log;
pub mod provenance;
pub mod repo;
pub mod status;
pub mod worktree;

pub use error::GitError;
pub use head::Head;
pub use log::Commit;
pub use status::{RepoStatus, StatusEntry};
pub use worktree::WorktreeInfo;
