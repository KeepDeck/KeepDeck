//! `keepdeck-agents` — the catalog of coding agents KeepDeck can launch, and
//! detection of which are actually installed.
//!
//! This is the single source of truth for the agent set (id, label, candidate
//! binaries). The frontend used to hardcode the same list in TypeScript; now it
//! is authored here once and the UI fetches it, so the two can't drift.
//!
//! Detection is **presence-only**: a binary is "installed" if it resolves to an
//! executable on the augmented `PATH` ([`keepdeck_env`]). We do not spawn
//! `--version` — detection stays fast and side-effect-free, and uses the *same*
//! resolver the PTY layer spawns through, so "detected installed" and "spawn
//! finds the binary" can never disagree.
//!
//! This crate is framework-free (no serde / no Tauri); the delivery layer maps
//! [`AgentStatus`] to its own DTO.

use std::ffi::OsStr;
use std::path::PathBuf;

/// A first-class agent KeepDeck knows how to launch. A static catalog entry.
///
/// Richer metadata (resume strategy for [F8], icon / default args / key quirks
/// for [F9]) will extend this struct when those features land — adding a field
/// is a localized change that leaves detection and the existing UI untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentSpec {
    /// Stable identifier, mirrored by the frontend `AgentType` union (`"claude"`).
    pub id: &'static str,
    /// Human-facing name (`"Claude Code"`).
    pub label: &'static str,
    /// Candidate executable names, tried in order; the first found wins. A slice
    /// (not a single name) so a CLI renamed across versions can still be found.
    pub bin: &'static [&'static str],
}

/// The canonical set of supported agents. Order is the UI's display order and
/// matches the frontend's historical list (Claude Code, OpenCode, Codex).
pub static AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        label: "Claude Code",
        bin: &["claude"],
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        bin: &["opencode"],
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        bin: &["codex"],
    },
];

/// A catalog agent annotated with whether it's installed on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStatus {
    /// The spec's [`AgentSpec::id`].
    pub id: String,
    /// The spec's [`AgentSpec::label`].
    pub label: String,
    /// The command to spawn: the candidate binary that resolved, or the first
    /// candidate when none did (the caller hides uninstalled agents, so the
    /// not-found value is only a sensible fallback, never actually spawned).
    pub command: String,
    /// Whether a candidate binary resolved on the augmented `PATH`.
    pub installed: bool,
    /// Absolute path of the resolved binary, when installed.
    pub path: Option<PathBuf>,
}

impl AgentSpec {
    /// Detect this agent against `path`: try each candidate binary in order and
    /// report the first that resolves to an executable.
    pub fn detect(&self, path: &OsStr) -> AgentStatus {
        let found = self
            .bin
            .iter()
            .find_map(|&bin| keepdeck_env::find_program(bin, path).map(|abs| (bin, abs)));
        match found {
            Some((bin, abs)) => AgentStatus {
                id: self.id.to_string(),
                label: self.label.to_string(),
                command: bin.to_string(),
                installed: true,
                path: Some(abs),
            },
            None => AgentStatus {
                id: self.id.to_string(),
                label: self.label.to_string(),
                // Invariant: every catalog entry has at least one candidate.
                command: self.bin.first().copied().unwrap_or(self.id).to_string(),
                installed: false,
                path: None,
            },
        }
    }
}

/// Detect every catalog agent against `path`. Pure in `path` (no global lookup)
/// so callers can inject a test `PATH`; the delivery layer uses [`list`].
pub fn detect(path: &OsStr) -> Vec<AgentStatus> {
    AGENTS.iter().map(|spec| spec.detect(path)).collect()
}

/// Detect every catalog agent against the process's augmented `PATH`.
pub fn list() -> Vec<AgentStatus> {
    detect(keepdeck_env::augmented_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    /// Create an executable file at `dir/name` (Unix perms 0o755).
    fn make_exec(dir: &Path, name: &str) {
        let p = dir.join(name);
        fs::write(&p, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A unique temp dir under the OS temp root (no external deps).
    fn temp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("kd-agents-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn catalog_invariants_hold() {
        let mut seen = std::collections::HashSet::new();
        for spec in AGENTS {
            assert!(!spec.id.is_empty(), "id must be non-empty");
            assert!(!spec.label.is_empty(), "label must be non-empty");
            assert!(!spec.bin.is_empty(), "{} must have a candidate bin", spec.id);
            assert!(seen.insert(spec.id), "duplicate id {}", spec.id);
        }
    }

    #[cfg(unix)]
    #[test]
    fn detects_installed_and_missing_against_an_injected_path() {
        let dir = temp_dir("detect");
        // Only `claude` is on the fake PATH.
        make_exec(&dir, "claude");
        let path = OsString::from(dir.as_os_str());

        let statuses = detect(&path);
        let claude = statuses.iter().find(|s| s.id == "claude").unwrap();
        assert!(claude.installed);
        assert_eq!(claude.command, "claude");
        assert_eq!(claude.path.as_deref(), Some(dir.join("claude").as_path()));

        let codex = statuses.iter().find(|s| s.id == "codex").unwrap();
        assert!(!codex.installed);
        assert_eq!(codex.command, "codex"); // fallback to the first candidate
        assert_eq!(codex.path, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_covers_every_catalog_agent() {
        // An empty PATH → nothing installed, but one status per catalog entry.
        let statuses = detect(OsStr::new(""));
        assert_eq!(statuses.len(), AGENTS.len());
        assert!(statuses.iter().all(|s| !s.installed));
    }
}
