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

/// The home directory name per compile profile — siblings, not nested, so a
/// bug-report zip of the release home carries no dev leftovers.
const HOME_DIR: &str = if cfg!(debug_assertions) {
    "keepdeck-dev"
} else {
    "keepdeck"
};

/// This build's home, by the precedence above. `None` only in degenerate
/// environments with none of the variables — callers must treat that as "no
/// persistence", never as an error.
pub fn keepdeck_home() -> Option<PathBuf> {
    home_from(
        HOME_DIR,
        std::env::var_os("KEEPDECK_HOME"),
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )
}

/// Where log files go: `<keepdeck_home>/logs`.
pub fn logs_dir() -> Option<PathBuf> {
    keepdeck_home().map(|home| home.join("logs"))
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
        .or_else(|| home.map(|h| PathBuf::from(h).join(".config")))?;
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
}
