//! `keepdeck-env` — the environment for spawned children: PATH augmentation,
//! program resolution, and a UTF-8 locale.
//!
//! A GUI-launched macOS app inherits launchd's stripped `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so user-installed CLIs (`claude`, `codex`,
//! `opencode`) and their toolchains aren't found. We rebuild a fuller `PATH` —
//! the login shell's `PATH` plus well-known install dirs, merged over the
//! inherited one — and resolve programs against it. Computed once per process;
//! the login-shell probe is the only cost and it's cached.
//!
//! This is the single source of "where to find a binary", shared by the PTY
//! layer (resolving the program to spawn) and the agent layer (detecting which
//! agent CLIs are installed) so the two never disagree.
//!
//! The same launchd environment also carries no `LANG`/`LC_*`, so [`utf8_lang`]
//! supplies the UTF-8 locale that terminal children need (see its docs for the
//! pbcopy/MacRoman failure this prevents).

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

/// The augmented `PATH` for spawned children and agent detection, computed once.
pub fn augmented_path() -> &'static OsStr {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(build_path).as_os_str()
}

/// The locale handed to children that would otherwise have none. Only the
/// charmap matters (UTF-8); the language part is the conventional tool default.
pub const FALLBACK_UTF8_LANG: &str = "en_US.UTF-8";

/// A UTF-8 `LANG` for spawned children when the inherited environment selects
/// no UTF-8 locale, computed once; `None` when the environment already does.
///
/// A GUI-launched app gets launchd's environment, which has no `LANG`/`LC_*`,
/// so everything inside a pane runs in the C locale and locale-sensitive tools
/// treat text as MacRoman — `pbcopy` then garbles every non-ASCII copy (its
/// UTF-8 stdin is read as MacRoman and re-encoded onto the pasteboard).
/// Terminal emulators set `LANG` for their children for exactly this reason.
///
/// An inherited non-UTF-8 `LC_ALL` would still beat the `LANG` we add —
/// deliberately not overridden: whoever set it asked for that locale.
pub fn utf8_lang() -> Option<&'static str> {
    static NEEDED: OnceLock<bool> = OnceLock::new();
    NEEDED
        .get_or_init(|| needs_utf8_lang(std::env::vars()))
        .then_some(FALLBACK_UTF8_LANG)
}

/// True when none of `LC_ALL`/`LC_CTYPE`/`LANG` in `vars` selects a UTF-8
/// charmap (a value containing "UTF-8"/"utf8", any case).
fn needs_utf8_lang(vars: impl IntoIterator<Item = (String, String)>) -> bool {
    !vars.into_iter().any(|(key, value)| {
        matches!(key.as_str(), "LC_ALL" | "LC_CTYPE" | "LANG")
            && value.to_ascii_lowercase().replace('-', "").contains("utf8")
    })
}

/// Resolve a bare command name to an absolute path using `path`, for spawning.
/// Returns the command unchanged if it already contains a `/` or isn't found on
/// `path` (let the spawn surface the "not found" error as before).
pub fn resolve_program(command: &str, path: &OsStr) -> OsString {
    if command.is_empty() || command.contains('/') {
        return command.into();
    }
    find_program(command, path)
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| command.into())
}

/// Find `command` on `path`, returning the absolute path of the first executable
/// match, or `None` if it isn't installed. Unlike [`resolve_program`] this
/// reports absence (for detection): `None` means "not found", not "spawn it and
/// let it fail". A `command` that is itself a path is checked directly.
pub fn find_program(command: &str, path: &OsStr) -> Option<PathBuf> {
    if command.is_empty() {
        return None;
    }
    if command.contains('/') {
        let direct = Path::new(command);
        return is_executable(direct).then(|| direct.to_path_buf());
    }
    std::env::split_paths(path)
        .map(|dir| dir.join(command))
        .find(|candidate| is_executable(candidate))
}

fn build_path() -> OsString {
    let mut seen: HashSet<OsString> = HashSet::new();
    let mut dirs: Vec<PathBuf> = Vec::new();

    // Login shell first (the user's real PATH), then the inherited PATH, then
    // well-known install dirs — first occurrence wins.
    if let Some(login) = login_shell_path() {
        add_dirs(std::env::split_paths(&login), &mut dirs, &mut seen);
    }
    if let Some(current) = std::env::var_os("PATH") {
        add_dirs(std::env::split_paths(&current), &mut dirs, &mut seen);
    }
    add_dirs(well_known_dirs(), &mut dirs, &mut seen);

    std::env::join_paths(&dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn add_dirs<I: IntoIterator<Item = PathBuf>>(
    entries: I,
    dirs: &mut Vec<PathBuf>,
    seen: &mut HashSet<OsString>,
) {
    for dir in entries {
        let key = dir.as_os_str().to_os_string();
        if !key.is_empty() && seen.insert(key) {
            dirs.push(dir);
        }
    }
}

/// Capture `PATH` from the user's login shell (`$SHELL -ilc 'printf %s "$PATH"'`).
///
/// Spawned with a handle so a hung rc file can't leak: on timeout we kill + reap
/// the child, which closes its stdout and so ends the reader thread (vs. a bare
/// `Command::output()`, whose worker would stay blocked reading a live process).
fn login_shell_path() -> Option<String> {
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty())?;
    let mut child = Command::new(&shell)
        .arg("-ilc")
        .arg(r#"printf %s "$PATH""#)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });

    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(out) => {
            let _ = child.wait();
            let path = out.trim().to_string();
            (!path.is_empty()).then_some(path)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Common install dirs that a stripped `PATH` misses (Homebrew, Cargo, npm/bun,
/// etc.). Harmless when absent — non-existent dirs just never resolve anything.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for sub in [
            ".cargo/bin",
            ".local/bin",
            ".bun/bin",
            ".deno/bin",
            ".volta/bin",
            ".npm-global/bin",
        ] {
            dirs.push(home.join(sub));
        }
    }
    dirs
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn empty_environment_needs_a_utf8_lang() {
        assert!(needs_utf8_lang(vars(&[])));
    }

    #[test]
    fn any_utf8_locale_var_satisfies_it() {
        assert!(!needs_utf8_lang(vars(&[("LANG", "en_US.UTF-8")])));
        assert!(!needs_utf8_lang(vars(&[("LC_CTYPE", "UTF-8")])));
        assert!(!needs_utf8_lang(vars(&[("LC_ALL", "ru_RU.utf8")])));
    }

    #[test]
    fn non_utf8_locales_still_need_one() {
        assert!(needs_utf8_lang(vars(&[("LANG", "C"), ("LC_ALL", "POSIX")])));
    }

    #[test]
    fn utf8_in_unrelated_vars_does_not_count() {
        assert!(needs_utf8_lang(vars(&[("EDITOR", "vim-utf8"), ("LANG", "C")])));
    }

    #[test]
    fn keeps_a_command_with_a_slash() {
        assert_eq!(
            resolve_program("/bin/echo", OsStr::new("/nope")),
            OsString::from("/bin/echo"),
        );
    }

    #[test]
    fn finds_an_executable_on_the_path() {
        let resolved = resolve_program("sh", OsStr::new("/usr/bin:/bin"));
        assert!(
            resolved == OsString::from("/bin/sh") || resolved == OsString::from("/usr/bin/sh"),
            "expected an absolute /bin/sh-ish path, got {resolved:?}",
        );
    }

    #[test]
    fn returns_the_bare_name_when_not_found() {
        assert_eq!(
            resolve_program("keepdeck-no-such-binary-xyz", OsStr::new("/usr/bin:/bin")),
            OsString::from("keepdeck-no-such-binary-xyz"),
        );
    }

    #[test]
    fn find_program_reports_absence_as_none() {
        assert_eq!(
            find_program("keepdeck-no-such-binary-xyz", OsStr::new("/usr/bin:/bin")),
            None,
        );
    }

    #[test]
    fn find_program_returns_the_resolved_absolute_path() {
        let found = find_program("sh", OsStr::new("/usr/bin:/bin"))
            .expect("sh should resolve on a standard PATH");
        assert!(found.is_absolute());
        assert!(found.ends_with("sh"));
        assert!(is_executable(&found));
    }

    #[test]
    fn find_program_checks_a_slash_command_directly() {
        assert_eq!(
            find_program("/bin/sh", OsStr::new("/nope")),
            Some(PathBuf::from("/bin/sh")),
        );
        assert_eq!(find_program("/no/such/path", OsStr::new("/nope")), None);
    }

    #[test]
    fn find_program_treats_empty_as_absent() {
        assert_eq!(find_program("", OsStr::new("/usr/bin:/bin")), None);
    }

    #[test]
    fn add_dirs_dedupes_and_keeps_first_occurrence() {
        let mut dirs = Vec::new();
        let mut seen = HashSet::new();
        add_dirs(
            [
                PathBuf::from("/a"),
                PathBuf::from("/b"),
                PathBuf::from("/a"), // duplicate
                PathBuf::from(""),   // empty skipped
                PathBuf::from("/c"),
            ],
            &mut dirs,
            &mut seen,
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/a"),
                PathBuf::from("/b"),
                PathBuf::from("/c"),
            ],
        );
    }
}
