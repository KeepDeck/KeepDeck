//! Agent detection delivery layer.
//!
//! Which agents EXIST is the cli plugins' business (their `agents`
//! contributions carry id/label/bin); this adapter only answers the generic
//! question "does this binary resolve?" — on the SAME augmented PATH the PTY
//! spawn uses, so "detected" == "spawnable" stays true by construction.

use serde::Serialize;

/// Install status of one requested binary name — the generic detection agent
/// plugins resolve their declared `detect.bin` through (mirrors the TS
/// `BinStatus`, camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinStatusDto {
    pub bin: String,
    pub installed: bool,
    /// Absolute path of the resolved binary, when installed.
    pub path: Option<String>,
}

/// Detect which of the requested binaries resolve — on the SAME augmented
/// PATH the PTY spawn uses, so "detected" == "spawnable" stays true by
/// construction.
///
/// Presence ONLY, and nothing here starts a process. A PATH lookup costs
/// microseconds and everyone needs the answer — the agent picker, the plugin
/// availability gate — so it stays cheap enough to call per form open, as it
/// says on the tin.
///
/// Asking a binary its VERSION is a different question with a different
/// price (see [`agents_probe_version`]), and the two were briefly answered by
/// one call. That made every boot pay for a fact almost nobody read.
#[tauri::command]
pub fn agents_detect(bins: Vec<String>) -> Vec<BinStatusDto> {
    detect_bins(bins, keepdeck_env::augmented_path())
}

fn detect_bins(bins: Vec<String>, path: &std::ffi::OsStr) -> Vec<BinStatusDto> {
    bins.into_iter()
        .map(|bin| {
            let found = keepdeck_env::find_program(&bin, path);
            BinStatusDto {
                installed: found.is_some(),
                // Lossy is fine for display; agent binaries live at UTF-8 paths.
                path: found.map(|p| p.to_string_lossy().into_owned()),
                bin,
            }
        })
        .collect()
}

/// What `bin` answers to `--version`, or null when it could not be asked.
///
/// ASYNC and on the blocking pool, because this RUNS a program: measured on
/// a normal install it costs ~460ms for one CLI, and a synchronous Tauri
/// command runs on the MAIN thread — which is a frozen window for as long as
/// the CLI takes to print one line.
///
/// Its own command rather than a flag on the detection above, because the
/// caller decides WHEN it is worth paying. The deck asks once, when a pane
/// with that agent starts, and remembers the answer; nothing waits on it.
#[tauri::command]
pub async fn agents_probe_version(bin: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        version_of(&bin, keepdeck_env::augmented_path())
    })
    .await
    // A panicking blocking task reads as "could not tell", like every other
    // failure here: null means "assume the current protocol", never "old".
    .ok()
    .flatten()
}

/// Resolve `bin` on `path` and ask it. The command's whole body, kept apart
/// from the async wrapper so the tests exercise what actually runs rather
/// than a hand-copied twin of it.
fn version_of(bin: &str, path: &std::ffi::OsStr) -> Option<String> {
    probe_version(&keepdeck_env::find_program(bin, path)?, path)
}

/// How long a `--version` probe may take before it is killed, and how often
/// it is checked. Two seconds is generous for a program that answers by
/// printing one line; the poll is short enough that a normal probe adds
/// nothing measurable to boot.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const PROBE_POLL: std::time::Duration = std::time::Duration::from_millis(10);

/// Ask a resolved binary what version it is, best-effort.
///
/// `--version` is the one flag every agent CLI here answers, and it is the
/// only way to tell WHICH protocol a given install speaks: a CLI's own wire
/// formats move between releases — codex replaced its hook-output schema
/// wholesale between 0.146 and 0.147 — and a plugin that must speak the
/// right one has nothing else to go on. Everything about this fails
/// quietly: a binary
/// that does not take the flag, hangs, or prints something unparseable
/// yields `None`, which reads as "unknown" and never as "old".
///
/// It runs on the augmented spawn PATH, like the resolution above, so a CLI
/// that shells out to a sibling tool finds it.
fn probe_version(program: &std::path::Path, path: &std::ffi::OsStr) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command.arg("--version").env("PATH", path);
    // A version banner is printed immediately or not at all; anything slower
    // is not answering.
    let output = crate::run_bounded::run_bounded(
        &mut command,
        PROBE_TIMEOUT,
        PROBE_POLL,
        MAX_VERSION_BYTES,
    )?;
    // Lossy: see the discipline's own comment — a stray non-UTF-8 byte must
    // not cost the version printed before it. The exit status is ignored on
    // purpose, as it always was: a banner printed by a failing run is still
    // the answer to "which protocol is this".
    parse_version(&String::from_utf8_lossy(&output.said))
}

/// How much of a `--version` answer is worth reading. A banner is a line;
/// anything past this is a program doing something else.
const MAX_VERSION_BYTES: u64 = 8 * 1024;

/// The first dotted number in a version banner: `codex-cli 0.147.0` and
/// `2.1.226 (Claude Code)` both answer, and a line with no number at all
/// does not. Two components are enough to be a version — `0.147` is one.
fn parse_version(said: &str) -> Option<String> {
    said.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|token| {
            let mut parts = token.split('.');
            let leading_two = (parts.next(), parts.next());
            matches!(leading_two, (Some(a), Some(b)) if !a.is_empty() && !b.is_empty())
                && parts.all(|part| !part.is_empty())
                && !token.ends_with('.')
        })
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the command runs, on a PATH the test controls.
    use super::version_of as probing;

    #[test]
    fn detects_requested_bins_on_the_given_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-fake-agent");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let statuses = detect_bins(
            vec!["kd-fake-agent".into(), "kd-absent-agent".into()],
            dir.path().as_os_str(),
        );
        assert_eq!(statuses.len(), 2);
        assert!(statuses[0].installed);
        assert_eq!(statuses[0].path.as_deref(), Some(bin.to_str().unwrap()));
        assert!(!statuses[1].installed);
        assert_eq!(statuses[1].path, None);

        // The wire shape the webview reads — pin the camelCase field.
        let json = serde_json::to_value(&statuses[0]).unwrap();
        assert_eq!(json["bin"], "kd-fake-agent");
        assert_eq!(json["installed"], true);
        // Presence carries NO version: that is a separate question with a
        // separate price, and a field that is always absent would only
        // invite somebody to read it.
        assert_eq!(json.get("version"), None);
    }

    #[cfg(unix)]
    #[test]
    fn reports_the_version_a_binary_answers_with() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-versioned-agent");
        // The real shape: the flag is honoured, the banner names the tool.
        std::fs::write(&bin, "#!/bin/sh\necho 'codex-cli 0.147.0'\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            probing("kd-versioned-agent", dir.path().as_os_str()).as_deref(),
            Some("0.147.0")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_binary_that_refuses_the_flag_reports_no_version_rather_than_failing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-grumpy-agent");
        std::fs::write(&bin, "#!/bin/sh\necho 'unknown option' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Still installed — detection never hinged on the version probe, and
        // now it cannot: they are different calls.
        assert!(detect_bins(vec!["kd-grumpy-agent".into()], dir.path().as_os_str())[0].installed);
        assert_eq!(probing("kd-grumpy-agent", dir.path().as_os_str()), None);
    }

    #[cfg(unix)]
    #[test]
    fn detection_never_runs_anything_at_all() {
        // The security half, and now a structural one: detection has no way
        // to run a program, because asking a version is a different command.
        // A probe EXECUTES a name that came out of a manifest, so it is gated
        // by the `exec` capability the deck checks before calling it — and
        // being asked whether you EXIST is never consent to be run.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ran = dir.path().join("it-ran");
        let bin = dir.path().join("kd-uninvited-agent");
        std::fs::write(
            &bin,
            format!("#!/bin/sh\ntouch '{}'\necho 'tool 9.9.9'\n", ran.display()),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let statuses = detect_bins(vec!["kd-uninvited-agent".into()], dir.path().as_os_str());
        assert!(statuses[0].installed, "presence is still answered");
        assert!(!ran.exists(), "detection must not execute anything");
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_binary_that_never_answers_rather_than_waiting_on_it() {
        // Nothing waits on a probe, but "nothing waits" is not "anything
        // goes": a program that never exits would hold a pool thread for the
        // life of the app, and one per agent would leak them. The bound is
        // what makes running somebody else's binary safe at all.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-hanging-agent");
        std::fs::write(&bin, "#!/bin/sh\nsleep 60\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        // The probe runs the program on the SAME path it resolved it from, so
        // the stub needs `/bin` to find `sleep` — exactly as a real CLI that
        // shells out to a sibling tool does.
        let path = std::env::join_paths([dir.path(), std::path::Path::new("/bin")]).unwrap();
        let began = std::time::Instant::now();
        let version = probing("kd-hanging-agent", &path);
        let waited = began.elapsed();

        // Installed, with no version — a probe that could not answer is
        // "unknown", never "absent": gating availability on it would hide a
        // working CLI.
        assert!(detect_bins(vec!["kd-hanging-agent".into()], &path)[0].installed);
        assert_eq!(version, None);
        assert!(waited >= PROBE_TIMEOUT, "gave up too early: {waited:?}");
        assert!(
            waited < PROBE_TIMEOUT * 3,
            "waited past the bound: {waited:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_banner_when_the_cli_also_warns_on_stderr() {
        // stdout and stderr were given two `reopen()` handles, which are two
        // file descriptions with two offsets — so the second writer started
        // at byte 0 and erased the first. Any CLI that prints a deprecation
        // notice alongside its version lost the version, and `cliVersion` is
        // what a renderer branches on to pick a hook-output schema.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-warning-agent");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho 'mytool 1.2.3'\necho 'warning: config schema 2.0.0 is deprecated' >&2\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        // The BANNER's version, not the one buried in the warning.
        assert_eq!(
            probing("kd-warning-agent", dir.path().as_os_str()).as_deref(),
            Some("1.2.3")
        );
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_version_past_a_byte_that_is_not_utf8() {
        // `read_to_string` failed the whole probe on one bad byte, throwing
        // away a version that was printed on line one. A banner is somebody
        // else's output: read it lossily or not at all.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-latin1-agent");
        std::fs::write(
            &bin,
            "#!/bin/sh\nprintf 'caf\\351 4.5.6\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            probing("kd-latin1-agent", dir.path().as_os_str()).as_deref(),
            Some("4.5.6")
        );
    }

    #[cfg(unix)]
    #[test]
    fn answers_a_cli_that_says_far_more_than_a_pipe_would_hold() {
        // Output went to a pipe, and nothing drained it while the wait loop
        // polled — so a CLI printing more than the 64 KB buffer blocked on
        // its own write, was killed at the deadline, and reported no version
        // at all. A file has no such buffer, and the version is still found
        // in what the program said first.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-chatty-agent");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho 'chatty-cli 3.2.1'\nawk 'BEGIN{while(i++<200000)print \"noise\"}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path = std::env::join_paths([dir.path(), std::path::Path::new("/usr/bin")]).unwrap();
        let began = std::time::Instant::now();
        assert_eq!(probing("kd-chatty-agent", &path).as_deref(), Some("3.2.1"));
        // And it did not spend the whole deadline blocked on a full buffer.
        assert!(began.elapsed() < PROBE_TIMEOUT, "{:?}", began.elapsed());
    }

    #[test]
    fn reads_a_version_out_of_whatever_banner_a_cli_prints() {
        // The two real shapes, and the ones that must not be mistaken for a
        // version: a lone integer is not one, and a trailing dot is not
        // either. Absent beats wrong here — a wrong version routes a plugin
        // down the wrong protocol.
        assert_eq!(parse_version("codex-cli 0.147.0\n").as_deref(), Some("0.147.0"));
        assert_eq!(parse_version("2.1.226 (Claude Code)").as_deref(), Some("2.1.226"));
        assert_eq!(parse_version("v1.2\n").as_deref(), Some("1.2"));
        assert_eq!(parse_version("build 12345"), None);
        assert_eq!(parse_version("no numbers here"), None);
        assert_eq!(parse_version(""), None);
    }
}
