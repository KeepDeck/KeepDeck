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
use std::path::{Path, PathBuf};

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

/// The directory belonging to ONE pane, created if it is not there yet.
///
/// Every file this run exchanges with a pane's agent lives here rather than
/// in the run directory itself. What that buys is NOT secrecy — panes run as
/// the same OS user, so one agent's shell can read any other's files no
/// matter how they are arranged, and no filesystem layout changes that.
/// Saying otherwise would be the dangerous kind of comment.
///
/// What it buys is that an answer is addressed by the PANE it is for. The
/// asker names a correlation and the deck decides whose directory it lands
/// in, so a pane naming somebody else's correlation reaches nobody. It also
/// keeps one pane's stray `$dir/*` glob out of another's traffic, which is
/// the failure a confused agent produces long before a hostile one does.
pub fn pane_dir(run_dir: &Path, pane_id: &str) -> Result<PathBuf, String> {
    if !is_usable_name(pane_id) {
        return Err(format!(
            "refusing a pane id that cannot be a directory name: {pane_id:?}"
        ));
    }
    let dir = run_dir.join(pane_id);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {pane_id}'s inbox failed: {e}"))?;
    super::inbox::restrict(&dir);
    Ok(dir)
}

/// Where one of a pane's files WOULD be, without creating anything.
///
/// The reading half of [`pane_dir`]: checking whether an answer is still
/// sitting there, or removing one, must not conjure a directory for a pane
/// that never had one. Same layout, stated once — a caller that composed
/// `run_dir.join(pane).join(file)` for itself would keep answering the old
/// question the day this layout changes, and the failure would be a reply
/// written to one place and looked for in another.
///
/// It applies the SAME permit-list, and answers `None` rather than a path
/// when either name fails it. That is not redundancy: one of its callers
/// DELETES what it names, and a version that trusted its arguments would
/// rest on a check performed in a different function — which is a fact about
/// today's callers, not a property of this one.
pub fn pane_path(run_dir: &Path, pane_id: &str, file: &str) -> Option<PathBuf> {
    if !is_usable_name(pane_id) {
        return None;
    }
    // The FILE carries an extension, so it is checked in the part that is a
    // name: `abc-123.reply` is `abc-123` plus a suffix this module does not
    // get to choose. Anything with a separator or a second dot is not a name.
    let (stem, extension) = file.rsplit_once('.')?;
    if !is_usable_name(stem) || !is_usable_name(extension) {
        return None;
    }
    Some(run_dir.join(pane_id).join(file))
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
    // Checked here as well as at every caller, for the reason `pane_path`
    // gives: today's callers are safe, and that is a fact about them rather
    // than a property of this function.
    if !file.rsplit_once('.').is_some_and(|(stem, ext)| {
        is_usable_name(stem) && is_usable_name(ext)
    }) {
        return Err(format!("refusing a filename that is not a plain name: {file:?}"));
    }
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
    fn a_pane_gets_its_own_directory_and_a_hostile_id_gets_none() {
        let run = tempfile::tempdir().unwrap();
        let dir = pane_dir(run.path(), "pane-3").unwrap();
        assert!(dir.is_dir());
        assert_eq!(dir, run.path().join("pane-3"));
        // Idempotent: every reply and every wake asks for it again.
        assert_eq!(pane_dir(run.path(), "pane-3").unwrap(), dir);
        for hostile in ["../escaped", "..", "a/b", ""] {
            assert!(pane_dir(run.path(), hostile).is_err(), "must refuse {hostile:?}");
        }
        assert_eq!(fs::read_dir(run.path()).unwrap().count(), 1);
    }

    #[test]
    fn naming_a_pane_s_file_creates_nothing() {
        // The reading half. Asking whether an answer is still sitting there —
        // or removing one — must not conjure a directory for a pane that
        // never had one, which is what makes this separate from `pane_dir`.
        let run = tempfile::tempdir().unwrap();
        let path = pane_path(run.path(), "pane-3", "id-1.reply").unwrap();
        assert_eq!(path, run.path().join("pane-3").join("id-1.reply"));
        assert_eq!(fs::read_dir(run.path()).unwrap().count(), 0);
        // And it agrees with where `pane_dir` puts things, which is the whole
        // reason both live here.
        assert_eq!(path.parent().unwrap(), pane_dir(run.path(), "pane-3").unwrap());
    }

    #[test]
    fn naming_refuses_exactly_what_creating_refuses() {
        // One of its callers DELETES what it names. Trusting the arguments
        // would rest the safety of that delete on a check performed in a
        // different function — a fact about today's callers, not a property
        // of this one.
        let run = tempfile::tempdir().unwrap();
        for pane in ["../escaped", "..", "a/b", "", "with space"] {
            assert!(pane_path(run.path(), pane, "id-1.reply").is_none(), "{pane:?}");
        }
        for file in ["../escaped.reply", "a/b.reply", "no-extension", ".reply", "a..reply"] {
            assert!(pane_path(run.path(), "pane-3", file).is_none(), "{file:?}");
        }
        assert!(pane_path(run.path(), "pane-3", "id-1.reply").is_some());
        assert!(pane_path(run.path(), "pane-3", "mail.wake").is_some());
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
