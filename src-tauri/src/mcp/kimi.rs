//! kimi's view of a pane cwd — where its MCP config lives, and nothing else.
//!
//! The same division [`crate::skills::opencode`] makes for staging: the arming
//! flow says WHEN a config is planted or taken back and what makes it provably
//! ours; this says WHAT it is called. A second file-fed CLI adds a view beside
//! this one instead of editing the flow every dialect shares.
//!
//! Only the two names below are kimi's. The marker that claims the directory
//! is KeepDeck's convention, identical for every dialect, so it stays with the
//! flow.

use std::path::{Path, PathBuf};

/// The directory kimi reads its MCP config from, inside the pane's cwd.
const DIR: &str = ".kimi-code";
/// The file it reads there.
const CONFIG: &str = "mcp.json";

/// One pane cwd, seen the way kimi sees it.
pub(super) struct View {
    dir: PathBuf,
    config: PathBuf,
}

impl View {
    pub(super) fn at(cwd: &Path) -> Self {
        let dir = cwd.join(DIR);
        Self {
            config: dir.join(CONFIG),
            dir,
        }
    }

    /// The planted directory. Git is kept blind to it by this name, and a
    /// non-directory here is the user's own — the flow decides what to do
    /// about that, the name is ours.
    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }

    /// The config itself.
    pub(super) fn config(&self) -> &Path {
        &self.config
    }

    /// The directory's name alone, for the `info/exclude` line and for the
    /// refusals that have to name what is actually there.
    pub(super) fn dir_name() -> &'static str {
        DIR
    }

    /// The config's name alone, for the same reason.
    pub(super) fn config_name() -> &'static str {
        CONFIG
    }
}
