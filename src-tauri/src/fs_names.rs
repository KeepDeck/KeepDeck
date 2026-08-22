//! One home for the filesystem-name rules both features share: the
//! path-segment safety wall (skill names, workspace ids — one plain
//! directory name, no traversal) and the sorted-subdirectory listing.
//! `skills/library.rs` and `artifacts/store.rs` WRAP these verdicts at
//! their call sites, keeping their own error types — the wall itself
//! has exactly one owner (the rules-lens round: two byte-logic copies
//! had already drifted into "the skills library's rule, as a COPY").

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// A safe single path segment: non-empty, ≤64 bytes, ASCII
/// alphanumerics plus `-`/`_`, starting alphanumeric — no traversal, no
/// separators, no surprises for any filesystem in play.
pub(crate) fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 64
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && segment.starts_with(|c: char| c.is_ascii_alphanumeric())
}

/// Subdirectories of `dir`, name-sorted. IO errors pass through
/// untouched — each feature's wrapper maps them to its own error type
/// (the per-side semantics their suites pin). A missing dir is EMPTY:
/// absence is not an error (both features' precedent).
pub(crate) fn sorted_dirs(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wall_accepts_the_plain_and_refuses_the_rest() {
        assert!(is_safe_segment("my-skill_2"));
        assert!(is_safe_segment("a"));
        assert!(!is_safe_segment(""));
        assert!(!is_safe_segment("-leading"));
        // `_` is not alphanumeric: a leading underscore refuses.
        assert!(!is_safe_segment("_under"));
        assert!(!is_safe_segment("has space"));
        assert!(!is_safe_segment("trav/ersal"));
        assert!(!is_safe_segment(".."));
        assert!(!is_safe_segment(&"x".repeat(65)));
    }

    #[test]
    fn a_missing_dir_lists_empty_and_errors_pass_through() {
        let missing = std::env::temp_dir().join("fs-names-no-such-dir");
        assert_eq!(sorted_dirs(&missing).unwrap(), Vec::<PathBuf>::new());
    }
}
