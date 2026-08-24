//! The plugin `fs` capability's backend: reading the USER'S project tree, and
//! keeping a directory's listing fresh.
//!
//! Distinct from [`crate::plugins_fs`], which serves a PLUGIN'S OWN bundle
//! files over `kdplugin://`. Two halves, one capability: [`read`] answers what
//! a directory or file holds RIGHT NOW, [`watch`] says when a directory's
//! listing stopped being what it was.
//!
//! ## The scope boundary
//!
//! The `fs` capability declares a scope (`packages/plugin-api`
//! `capabilities.ts`): `workspace` = the workspace folder and its panes'
//! worktrees, `everywhere` = no restriction (consent shouts it). The HOST
//! resolves that scope into a concrete set of allowed roots from live deck
//! state and passes them in with every call; this module enforces containment.
//!
//! Enforcement is [`crate::containment::resolve_within`] (shared with the
//! other project-facing service backends), the same canonicalize-then-`starts_with`
//! model [`crate::plugins_fs::safe_lookup`] uses: resolving `..` and symlinks
//! ON DISK is the only reliable escape guard, so a `../../etc/passwd`, an
//! absolute path outside the roots, or a symlink pointing out all resolve to a
//! real location the containment check then rejects. `everywhere` skips the
//! containment step but still canonicalizes (and still caps reads) — the
//! difference between the two scopes is exactly whether the roots are
//! consulted, nothing else.
//!
//! A workspace-scoped call with an EMPTY root set reads nothing: the safe
//! default for a plugin whose deck currently has no eligible folder open.
//!
//! Both halves answer to the SAME boundary — a directory a plugin may list is
//! a directory it may watch, by the same path string — so splitting them
//! across files must never split that rule. It lives here, above both.
//!
//! Read-only by design (v1): there is no write/create/delete surface here —
//! that needs its own capability, deliberately absent until it exists.

/// pub: the Tauri command macros must be reachable at the path the handler
/// list names, and a re-export moves the function without the macro — so the
/// registration says `project_fs::read::…`, the way `mcp::arming::…` does.
pub mod read;
pub mod watch;

pub use watch::ProjectFsWatchers;

/// Fixtures shared by both halves' tests.
///
/// Not a convenience: the two halves need the SAME kind of temp root, and two
/// private copies of one helper are how a shared derivation starts drifting —
/// this tree already carries a module that exists because exactly that
/// happened once.
#[cfg(test)]
pub(crate) mod testing {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A unique temp root per test (std-only; no tempfile dependency), matching
    /// `plugins_fs`'s test convention.
    pub(crate) fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kd-project-fs-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn write(path: &PathBuf, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    pub(crate) fn roots(root: &Path) -> Vec<String> {
        vec![root.to_string_lossy().into_owned()]
    }
}
