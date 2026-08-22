//! KeepDeck's self-owned home directory.
//!
//! Everything the app persists is meant to live under one folder the user can
//! find, grep, wipe or zip into a bug report — and each compile profile gets
//! its own folder, so a debug build can never touch real data:
//!
//! - release profile: `$XDG_CONFIG_HOME|~/.config` + `/keepdeck`
//! - debug profile:   `$XDG_CONFIG_HOME|~/.config` + `/keepdeck-dev`
//! - `$KEEPDECK_HOME` (absolute) overrides both — test isolation and
//!   deliberate cross-flavor runs.
//!
//! Logs live here today; the deck state and future settings migrate in later.
//!
//! Resolution deliberately avoids Tauri's path API: the log plugin needs the
//! folder at builder time, before an `AppHandle` exists.

use std::ffi::OsString;
use std::path::PathBuf;

/// This build's home, by the precedence above. `None` only in degenerate
/// environments with none of the variables — callers must treat that as "no
/// persistence", never as an error.
///
/// TEST BUILDS (`cargo test`): the home is a fresh tmp dir per test, by
/// construction — libtest spawns each test in its own thread, and the
/// thread-local below owns a TempDir for that thread's life (self-cleaning
/// at thread exit). A test binary can NEVER touch the real `keepdeck-dev`:
/// the env override is not read for resolution under `cfg(test)`.
///
/// Tripwire: if `KEEPDECK_HOME` is set in a test run's environment, this
/// panics with the remedy. A trip reports the PROCESS's state, not the
/// offending test — under parallelism a leaking setter can burn
/// home-resolving siblings (the env is process-global; fresh threads per
/// test do NOT isolate it), which is acceptable precisely because the
/// total-absence scan pin makes an in-tree setter unreachable. The only
/// reachable trip sources (a shell export, out-of-tree mutation) deserve
/// the full-suite red they produce. Degradation note: per-test isolation
/// is the OBSERVED granularity on this harness (fresh thread per test,
/// both modes, empirically pinned); a future pooling harness would
/// degrade it to per-thread — fail-safe (bleed inside one thread's tmp
/// home), never the real home.
pub fn keepdeck_home() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if std::env::var_os("KEEPDECK_HOME").is_some() {
            panic!(
                "KEEPDECK_HOME is set in a test run — test homes are a fresh \
                 tmp dir per test, by construction. To change the home, \
                 change paths.rs, not the env. (Shell export? unset it: \
                 `unsetenv KEEPDECK_HOME`.) See the tmp-home design note."
            );
        }
        Some(test_home())
    }
    #[cfg(not(test))]
    home_from(
        // Sibling folders per profile (keepdeck vs keepdeck-dev), so a
        // bug-report zip of the release home carries no dev leftovers.
        // Inlined HERE, its only use — nothing home-flavored is
        // addressable from a test build.
        if cfg!(debug_assertions) { "keepdeck-dev" } else { "keepdeck" },
        std::env::var_os("KEEPDECK_HOME"),
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )
}

/// The per-test tmp home (test builds only). Lazy: the first home resolve
/// on a thread creates the dir; the thread-local owns the TempDir, so it
/// lives as long as the test thread and removes itself at thread exit —
/// nothing drops early (the leaked-TempDir lesson), nothing leaks after.
#[cfg(test)]
fn test_home() -> PathBuf {
    use std::cell::RefCell;
    thread_local! {
        static HOME: RefCell<Option<tempfile::TempDir>> = RefCell::new(None);
    }
    HOME.with(|cell| {
        if cell.borrow().is_none() {
            *cell.borrow_mut() = Some(
                tempfile::tempdir().expect("creating the test tmp home failed"),
            );
        }
        cell.borrow().as_ref().expect("just set").path().to_path_buf()
    })
}

/// Where log files go: `<keepdeck_home>/logs`.
pub fn logs_dir() -> Option<PathBuf> {
    keepdeck_home().map(|home| home.join("logs"))
}

/// The MCP transport's unix socket: `<keepdeck_home>/mcp/mcp.sock`. The ONE
/// home of this location — the server binds it and the shim connects to it,
/// and the two must never derive it independently.
///
/// The `mcp/` directory is the transport's PERMISSION MODEL: the server
/// forces it to 0700, and connecting to a unix socket requires traversal of
/// every path component — so no other user reaches the socket regardless of
/// the mode bind(2) gave the file itself. That closes the bind-to-chmod
/// window at the filesystem, where a chmod-after-bind (or a staged rename,
/// which moves the name but not the inode's mode) provably cannot.
pub fn mcp_socket() -> Option<PathBuf> {
    keepdeck_home().map(|home| home.join("mcp").join("mcp.sock"))
}

/// An explicit `$KEEPDECK_HOME` IS the home; otherwise `dir` goes under
/// `$XDG_CONFIG_HOME`, else `$HOME/.config`. Relative paths in either
/// variable are ignored (per the XDG spec), falling through to the next rule.
fn home_from(
    dir: &str,
    explicit: Option<OsString>,
    xdg: Option<OsString>,
    home: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(chosen) = explicit.map(PathBuf::from).filter(|p| p.is_absolute()) {
        return Some(chosen);
    }
    let base = xdg
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            // $HOME is filtered too: a relative home would yield paths that
            // resolve against each process's OWN cwd — the app and the shim
            // would then disagree about where the socket is.
            home.map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .map(|h| h.join(".config"))
        })?;
    Some(base.join(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn explicit_home_wins_over_everything() {
        assert_eq!(
            home_from("keepdeck", os("/explicit"), os("/xdg"), os("/home/u")),
            Some(PathBuf::from("/explicit")),
        );
    }

    #[test]
    fn relative_explicit_home_is_ignored() {
        assert_eq!(
            home_from("keepdeck", os("relative/dir"), os("/xdg"), os("/home/u")),
            Some(PathBuf::from("/xdg/keepdeck")),
        );
    }

    #[test]
    fn flavor_dir_names_the_folder() {
        assert_eq!(
            home_from("keepdeck-dev", None, os("/xdg"), None),
            Some(PathBuf::from("/xdg/keepdeck-dev")),
        );
    }

    #[test]
    fn xdg_config_home_wins_over_home() {
        assert_eq!(
            home_from("keepdeck", None, os("/xdg"), os("/home/u")),
            Some(PathBuf::from("/xdg/keepdeck")),
        );
    }

    #[test]
    fn relative_xdg_is_ignored_per_spec() {
        assert_eq!(
            home_from("keepdeck", None, os("relative/dir"), os("/home/u")),
            Some(PathBuf::from("/home/u/.config/keepdeck")),
        );
    }

    #[test]
    fn falls_back_to_home_dot_config() {
        assert_eq!(
            home_from("keepdeck", None, None, os("/home/u")),
            Some(PathBuf::from("/home/u/.config/keepdeck")),
        );
    }

    #[test]
    fn no_env_means_no_home() {
        assert_eq!(home_from("keepdeck", None, None, None), None);
    }

    #[test]
    fn logs_dir_is_a_subfolder_of_home() {
        // Indirect: the pure resolver drives both public fns.
        let home = home_from("keepdeck", None, os("/xdg"), None).unwrap();
        assert_eq!(home.join("logs"), PathBuf::from("/xdg/keepdeck/logs"));
    }

    #[test]
    fn the_mcp_socket_lives_in_its_own_directory() {
        // Not flat in the home: that directory IS the socket's permission
        // model (0700), so the nesting is load-bearing, not cosmetic.
        let home = home_from("keepdeck", None, os("/xdg"), None).unwrap();
        assert_eq!(
            home.join("mcp").join("mcp.sock"),
            PathBuf::from("/xdg/keepdeck/mcp/mcp.sock"),
        );
    }

    #[test]
    fn a_relative_home_is_ignored_like_the_other_roots() {
        // A relative root would resolve against each process's own cwd —
        // the app and the shim would disagree about the socket's location.
        assert_eq!(home_from("keepdeck", None, None, os("relative/home")), None);
    }
}
