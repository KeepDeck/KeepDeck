//! What every file the deck writes INTO a run directory has in common.
//!
//! Two paths write here, for different reasons: [`super::reply`] answers a
//! hook that asked something, and [`super::nudge`] rings a doorbell for a
//! reporter that is watching. Both take their filename from outside the
//! bridge — a correlation minted by a hook, a pane id minted by the deck —
//! and both have to survive a reader polling the directory while they write.
//!
//! So both questions are answered once, here: what may become a filename,
//! and how a file is published so nobody reads half of it.

use std::fs;
use std::path::Path;

/// The longest name worth accepting. Correlations are minted per hook
/// invocation and pane ids per pane; neither has to be unique beyond one run
/// directory, and neither has any business being longer than this.
pub const MAX_NAME_LEN: usize = 64;

/// Whether `name` may become part of a filename.
///
/// ASCII alphanumerics, `-` and `_` only. Deliberately a permit-list: it
/// rejects `..`, `/`, NUL and every unicode look-alike in one rule, and a
/// permit-list cannot be outgrown by a separator nobody thought of. A name
/// that fails this is dropped rather than sanitised — a rewritten name would
/// answer a question nobody asked, and the reader waiting on the original
/// would wait just the same.
pub fn is_usable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Publish one file into `run_dir`, whole.
///
/// Staged beside the target so the rename stays within one filesystem, then
/// renamed — the same tmp + rename discipline the reporters use coming the
/// other way, and for the same reason: the readers here poll a directory and
/// must never open a file mid-write. `file` is the FULL name including its
/// extension; the caller has already decided what kind of file this is.
///
/// `Err` is a message for the log. Nothing on this path can be raised at a
/// user: a file that never lands leaves the reader believing the deck had
/// nothing to say, which is the recoverable direction.
pub fn publish(run_dir: &Path, file: &str, body: &str) -> Result<(), String> {
    let staged = run_dir.join(format!("{file}.tmp"));
    fs::write(&staged, body).map_err(|e| format!("staging {file} failed: {e}"))?;
    fs::rename(&staged, run_dir.join(file)).map_err(|e| {
        let _ = fs::remove_file(&staged);
        format!("publishing {file} failed: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_could_escape_the_run_directory_are_refused() {
        for hostile in ["../escaped", "..", "a/b", "", "with space", "nul\0byte"] {
            assert!(!is_usable_name(hostile), "must refuse {hostile:?}");
        }
        for fine in ["id-1", "pane_2", "abcDEF123"] {
            assert!(is_usable_name(fine), "must accept {fine:?}");
        }
        assert!(!is_usable_name(&"a".repeat(MAX_NAME_LEN + 1)));
        assert!(is_usable_name(&"a".repeat(MAX_NAME_LEN)));
    }

    #[test]
    fn a_published_file_lands_whole_with_no_staging_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        publish(dir.path(), "thing.reply", "body").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("thing.reply")).unwrap(),
            "body"
        );
        assert!(!dir.path().join("thing.reply.tmp").exists());
    }

    #[test]
    fn publishing_twice_replaces_rather_than_appends() {
        let dir = tempfile::tempdir().unwrap();
        publish(dir.path(), "thing.reply", "first").unwrap();
        publish(dir.path(), "thing.reply", "second").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("thing.reply")).unwrap(),
            "second"
        );
    }
}
