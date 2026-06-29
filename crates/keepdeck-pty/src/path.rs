//! Augmenting `PATH` for spawned agents.
//!
//! A GUI-launched macOS app inherits launchd's stripped `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so user-installed CLIs (`claude`, `codex`,
//! `opencode`) and their toolchains aren't found. We rebuild a fuller `PATH` —
//! the login shell's `PATH` plus well-known install dirs, merged over the
//! inherited one — and resolve the agent binary against it. Computed once per
//! process; the login-shell probe is the only cost and it's cached.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

/// The augmented `PATH` for spawned children, computed once.
pub(crate) fn augmented_path() -> &'static OsStr {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(build_path).as_os_str()
}

/// Resolve a bare command name to an absolute path using `path`. Returns the
/// command unchanged if it already contains a `/` or isn't found on `path` (let
/// the spawn surface the "not found" error as before).
pub(crate) fn resolve_program(command: &str, path: &OsStr) -> OsString {
    if command.is_empty() || command.contains('/') {
        return command.into();
    }
    for dir in std::env::split_paths(path) {
        let candidate = dir.join(command);
        if is_executable(&candidate) {
            return candidate.into_os_string();
        }
    }
    command.into()
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
}
