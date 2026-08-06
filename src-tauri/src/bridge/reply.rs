//! The bridge's return path: how the deck answers a hook that asked it
//! something.
//!
//! The inbox half is one-way by design — a reporter states a fact and walks
//! away. A delivery hook cannot: it has to ask "am I stopping, or is there
//! something for me?" and WAIT for the answer, because the answer changes
//! what it prints, and what it prints changes what the agent does next.
//!
//! The reply rides the same run directory, for the same reason the request
//! does: the hook already holds `dir`, `pane` and `token` in
//! `KEEPDECK_BRIDGE`, so an answer needs no second transport, no port and no
//! discovery. It is written tmp + rename like every other file here, so a
//! polling hook never reads half of one.
//!
//! The correlation id comes FROM the hook and travels through the webview
//! before landing in a filename, which makes it the one piece of untrusted
//! input on this path. It is validated here rather than at the edge that
//! produced it: this is the only place that turns it into a path, so this is
//! the only place that can be sure.

use std::fs;
use std::path::{Path, PathBuf};

/// The longest correlation id worth accepting. Ids are minted per hook
/// invocation and only have to be unique within one run directory.
const MAX_CORRELATION_LEN: usize = 64;

/// Whether `id` may become part of a filename.
///
/// ASCII alphanumerics, `-` and `_` only. Deliberately a permit-list: it
/// rejects `..`, `/`, NUL and every unicode look-alike in one rule, and a
/// permit-list cannot be outgrown by a separator nobody thought of. An id
/// that fails this is dropped rather than sanitised — a rewritten id would
/// answer a question nobody asked, and the hook that is waiting would time
/// out either way.
fn is_usable_correlation(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CORRELATION_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Where a reply for `id` lands inside `run_dir`.
///
/// The `.reply` extension keeps it out of the watcher's way: the inbox only
/// looks at `*.json`, so an answer on its way out is never mistaken for an
/// envelope coming in.
fn reply_path(run_dir: &Path, id: &str) -> PathBuf {
    run_dir.join(format!("{id}.reply"))
}

/// Write one reply, atomically. `Err` is a message for the log — a hook that
/// never sees its file simply times out and behaves as if the deck had
/// nothing to say, which is the safe direction.
pub fn write(run_dir: &Path, id: &str, body: &str) -> Result<(), String> {
    if !is_usable_correlation(id) {
        return Err(format!("refusing a reply id that cannot be a filename: {id:?}"));
    }
    let final_path = reply_path(run_dir, id);
    // Staged beside the target so the rename stays within one filesystem,
    // and named so a stray staging file is recognisable.
    let staged = run_dir.join(format!("{id}.reply.tmp"));
    fs::write(&staged, body).map_err(|e| format!("staging a reply failed: {e}"))?;
    fs::rename(&staged, &final_path).map_err(|e| {
        let _ = fs::remove_file(&staged);
        format!("publishing a reply failed: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_lands_whole_and_out_of_the_watcher_s_way() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "abc-123", "{\"block\":false}").unwrap();
        let path = dir.path().join("abc-123.reply");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"block\":false}");
        // The inbox watcher only consumes `*.json`; a reply must not look
        // like an envelope arriving.
        assert_ne!(path.extension().unwrap(), "json");
        // And no staging file survives a successful publish.
        assert!(!dir.path().join("abc-123.reply.tmp").exists());
    }

    #[test]
    fn ids_that_could_escape_the_run_directory_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("run-1");
        fs::create_dir(&run).unwrap();
        for hostile in ["../escaped", "..", "a/b", "", "with space", "nul\0byte"] {
            assert!(
                write(&run, hostile, "x").is_err(),
                "must refuse {hostile:?}"
            );
        }
        // Nothing was created anywhere, least of all outside the run dir.
        assert!(!root.path().join("escaped").exists());
        assert_eq!(fs::read_dir(&run).unwrap().count(), 0);
    }

    #[test]
    fn an_overlong_id_is_refused_before_it_reaches_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let long = "a".repeat(MAX_CORRELATION_LEN + 1);
        assert!(write(dir.path(), &long, "x").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_second_reply_for_the_same_id_replaces_the_first() {
        // A hook that retried, or a deck that changed its mind before the
        // hook read. Rename is atomic, so the reader sees one or the other
        // and never a mixture.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "id-1", "first").unwrap();
        write(dir.path(), "id-1", "second").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("id-1.reply")).unwrap(),
            "second"
        );
    }
}
