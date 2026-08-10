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
    /// The version it reports, when it reports one legibly.
    ///
    /// A CLI's own wire protocols move between releases — codex changed its
    /// hook-output schema wholesale between 0.146 and 0.147 — and a plugin
    /// that must speak the right one has no other way to know which. Purely
    /// informational: absent means "could not tell", never "old".
    pub version: Option<String>,
}

/// Detect which of the requested binaries resolve — on the SAME augmented
/// PATH the PTY spawn uses, so "detected" == "spawnable" stays true by
/// construction.
///
/// Presence is a PATH lookup: cheap, safe to call per form open, and asked
/// of every name in `bins`. A version is a program RUN, so it is asked only
/// of the names in `probe` — the caller's exec-capability decision, made
/// where capabilities are known and carried here rather than guessed at.
/// Omitting `probe` means "presence only", which is what every caller that
/// does not need a version should send.
#[tauri::command]
pub fn agents_detect(bins: Vec<String>, probe: Option<Vec<String>>) -> Vec<BinStatusDto> {
    detect_bins(
        bins,
        &probe.unwrap_or_default().into_iter().collect(),
        keepdeck_env::augmented_path(),
    )
}

fn detect_bins(
    bins: Vec<String>,
    probe: &std::collections::HashSet<String>,
    path: &std::ffi::OsStr,
) -> Vec<BinStatusDto> {
    bins.into_iter()
        .map(|bin| {
            let found = keepdeck_env::find_program(&bin, path);
            BinStatusDto {
                installed: found.is_some(),
                version: found
                    .as_deref()
                    .filter(|_| probe.contains(&bin))
                    .and_then(|p| probe_version(p, path)),
                // Lossy is fine for display; agent binaries live at UTF-8 paths.
                path: found.map(|p| p.to_string_lossy().into_owned()),
                bin,
            }
        })
        .collect()
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
/// only way to tell WHICH protocol a given install speaks — see
/// [`BinStatusDto::version`]. Everything about this fails quietly: a binary
/// that does not take the flag, hangs, or prints something unparseable
/// yields `None`, which reads as "unknown" and never as "old".
///
/// It runs on the augmented spawn PATH, like the resolution above, so a CLI
/// that shells out to a sibling tool finds it.
fn probe_version(program: &std::path::Path, path: &std::ffi::OsStr) -> Option<String> {
    let mut child = std::process::Command::new(program)
        .arg("--version")
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    // Bounded, because detection runs at boot and one program that never
    // exits would hold every agent's availability behind it — the pass is
    // sequential and the deck waits on all of it. A version banner is
    // printed immediately or not at all; anything slower is not answering.
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(PROBE_POLL);
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("agents: {} did not answer --version", program.display());
                return None;
            }
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    // stdout by convention, stderr because some CLIs answer there instead.
    let said = String::from_utf8_lossy(&out.stdout).into_owned()
        + &String::from_utf8_lossy(&out.stderr);
    parse_version(&said)
}

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

    /// Every requested bin, version probe allowed — what the plugin host asks
    /// for a bin an `exec` capability covers.
    fn probing(bins: Vec<String>, path: &std::ffi::OsStr) -> Vec<BinStatusDto> {
        let probe = bins.iter().cloned().collect();
        detect_bins(bins, &probe, path)
    }

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

        let statuses = probing(
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
        // A stub that says nothing has no version, and that is not a failure.
        assert_eq!(statuses[0].version, None);
        assert_eq!(statuses[1].version, None);
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

        let statuses = probing(vec!["kd-versioned-agent".into()], dir.path().as_os_str());
        assert_eq!(statuses[0].version.as_deref(), Some("0.147.0"));
    }

    #[cfg(unix)]
    #[test]
    fn a_binary_that_refuses_the_flag_reports_no_version_rather_than_failing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("kd-grumpy-agent");
        std::fs::write(&bin, "#!/bin/sh\necho 'unknown option' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let statuses = probing(vec!["kd-grumpy-agent".into()], dir.path().as_os_str());
        // Still installed — detection must not hinge on the version probe.
        assert!(statuses[0].installed);
        assert_eq!(statuses[0].version, None);
    }

    #[cfg(unix)]
    #[test]
    fn never_runs_a_binary_that_was_not_offered_for_probing() {
        // The security half. A version probe EXECUTES a program named by a
        // manifest field, at boot, for a plugin the user may have installed
        // and never enabled — so it is gated by the same `exec` capability
        // that governs a session spawn. Presence is a PATH lookup and stays
        // free; being asked about is not consent to be run.
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

        let statuses = detect_bins(
            vec!["kd-uninvited-agent".into()],
            &std::collections::HashSet::new(),
            dir.path().as_os_str(),
        );
        assert!(statuses[0].installed, "presence is still answered");
        assert_eq!(statuses[0].version, None);
        assert!(!ran.exists(), "an unprobed binary must not be executed");
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
