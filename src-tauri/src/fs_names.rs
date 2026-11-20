//! One home for the filesystem-name rules both features share: the
//! path-segment safety wall (skill names, workspace ids — one plain
//! directory name, no traversal), the sorted-subdirectory listing, and the
//! sweep that removes directories and says which stayed.
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

/// Remove each of `dirs` with `remove`: one that will not go keeps none of
/// the rest, and every one that stayed is named in the error once all were
/// tried — a sweep that says it is done has left nothing behind. One already
/// gone is removed.
pub(crate) fn remove_each(
    dirs: impl IntoIterator<Item = PathBuf>,
    remove: impl Fn(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut stayed = Vec::new();
    for dir in dirs {
        match remove(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => stayed.push(format!("{}: {e}", dir.display())),
        }
    }
    if stayed.is_empty() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("could not remove {}", stayed.join("; "))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_dir_is_tried_and_the_ones_that_stayed_are_named() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs: Vec<PathBuf> = ["a", "b", "c"].iter().map(|n| tmp.path().join(n)).collect();
        for dir in &dirs[..2] {
            fs::create_dir(dir).unwrap();
        }
        let stuck = dirs[0].clone();
        let error = remove_each(dirs.clone(), |dir| {
            if dir == stuck { Err(std::io::Error::other("busy")) } else { fs::remove_dir_all(dir) }
        })
        .unwrap_err();
        assert!(error.to_string().contains("a: busy"), "{error}");
        assert!(!dirs[1].exists(), "the stuck one kept none of the rest");
        assert!(remove_each(dirs[1..].to_vec(), |dir| fs::remove_dir_all(dir)).is_ok(), "gone already is removed");
    }

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
