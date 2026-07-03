//! KeepDeck's self-owned home directory.
//!
//! Everything the app persists is meant to live under one folder the user can
//! find, grep, wipe or zip into a bug report: `~/.config/keepdeck` (or
//! `$XDG_CONFIG_HOME/keepdeck` when set). Logs live here today; the deck state
//! and future settings migrate in later.
//!
//! Resolution deliberately avoids Tauri's path API: the log plugin needs the
//! folder at builder time, before an `AppHandle` exists.

use std::ffi::OsString;
use std::path::PathBuf;

/// `$XDG_CONFIG_HOME/keepdeck` when set (absolute paths only, per the XDG
/// spec), else `$HOME/.config/keepdeck`. `None` only in degenerate
/// environments with neither variable — callers must treat that as "no
/// persistence", never as an error.
pub fn keepdeck_home() -> Option<PathBuf> {
    home_from(std::env::var_os("XDG_CONFIG_HOME"), std::env::var_os("HOME"))
}

/// Where log files go: `<keepdeck_home>/logs`.
pub fn logs_dir() -> Option<PathBuf> {
    keepdeck_home().map(|home| home.join("logs"))
}

fn home_from(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    let base = xdg
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("keepdeck"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn xdg_config_home_wins_over_home() {
        assert_eq!(
            home_from(os("/xdg"), os("/home/u")),
            Some(PathBuf::from("/xdg/keepdeck")),
        );
    }

    #[test]
    fn relative_xdg_is_ignored_per_spec() {
        assert_eq!(
            home_from(os("relative/dir"), os("/home/u")),
            Some(PathBuf::from("/home/u/.config/keepdeck")),
        );
    }

    #[test]
    fn falls_back_to_home_dot_config() {
        assert_eq!(
            home_from(None, os("/home/u")),
            Some(PathBuf::from("/home/u/.config/keepdeck")),
        );
    }

    #[test]
    fn no_env_means_no_home() {
        assert_eq!(home_from(None, None), None);
    }

    #[test]
    fn logs_dir_is_a_subfolder_of_home() {
        // Indirect: the pure resolver drives both public fns.
        let home = home_from(os("/xdg"), None).unwrap();
        assert_eq!(home.join("logs"), PathBuf::from("/xdg/keepdeck/logs"));
    }
}
