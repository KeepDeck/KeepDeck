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

use super::spool;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long to wait before asking whether an answer was collected.
///
/// The hook polls for `ASK_TRIES * ASK_SLEEP` — 2s in kd-status-hook.sh — and
/// this is that window plus room for the last tick and the process's own
/// teardown. Too short and a hook still reading would be called a miss; too
/// long only delays the verdict, so it errs long.
pub const HOOK_WAIT: Duration = Duration::from_millis(2_500);

/// Where a reply for `id` lands: inside the directory of the pane being
/// ANSWERED, never one named by the asker.
///
/// That is the whole point of taking `pane` here. The correlation arrives in
/// an envelope, and an envelope can name any correlation its sender likes —
/// including one another pane is waiting on. The deck knows whose queue it
/// just emptied, so it, not the envelope, decides where the answer goes; a
/// correlation aimed at somebody else now simply reaches nobody.
///
/// The `.reply` extension keeps it out of the watcher's way: the inbox only
/// looks at `*.json`, so an answer on its way out is never mistaken for an
/// envelope coming in.
///
/// Through `spool`, like the write below — the layout of a pane's directory
/// is one fact, and a reply written to one place and looked for in another
/// is exactly what a second copy of it would produce.
fn reply_path(run_dir: &Path, pane_id: &str, id: &str) -> Option<PathBuf> {
    spool::pane_path(run_dir, pane_id, &reply_file(id))
}

/// The filename one answer takes.
fn reply_file(id: &str) -> String {
    format!("{id}.reply")
}

/// Write one reply, atomically. `Err` is a message for the log — a hook that
/// never sees its file simply times out and behaves as if the deck had
/// nothing to say, which is the safe direction.
pub fn write(run_dir: &Path, pane_id: &str, id: &str, body: &str) -> Result<(), String> {
    if !spool::is_usable_name(id) {
        return Err(format!("refusing a reply id that cannot be a filename: {id:?}"));
    }
    let dir = spool::pane_dir(run_dir, pane_id)?;
    spool::publish(&dir, &reply_file(id), body)
}

/// Whether the hook collected the answer written for `id`.
///
/// The script `cat`s the reply and REMOVES it in the same breath, so the file
/// still being here means nobody read it — a hook that timed out first, or a
/// process killed while waiting. That is the only evidence either side has:
/// the deck cannot see a hook run, and the hook cannot tell the deck it did.
///
/// Only meaningful once [`HOOK_WAIT`] has passed; asked earlier it reports
/// every answer as uncollected, because the hook is still polling for it.
pub fn was_collected(run_dir: &Path, pane_id: &str, id: &str) -> bool {
    // A name that cannot be a path never became a file, so there is nothing
    // outstanding on it — the same answer, reached without composing a path
    // out of something the permit-list refused.
    reply_path(run_dir, pane_id, id).is_none_or(|path| !path.exists())
}

/// Drop an answer nobody came for. Named apart from the check because the two
/// happen at different moments in the caller and only one of them is a
/// question: a stale reply that stays would outlive its run directory's
/// usefulness and, worse, could be read by a later hook that reused the name.
pub fn discard(run_dir: &Path, pane_id: &str, id: &str) {
    if let Some(path) = reply_path(run_dir, pane_id, id) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_reads_as_collected_only_once_the_file_is_gone() {
        // The hook's `cat` + `rm` is the entire protocol: nothing else tells
        // the deck whether its answer was read.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pane-1", "id-1", "mail").unwrap();
        assert!(!was_collected(dir.path(), "pane-1", "id-1"));
        fs::remove_file(dir.path().join("pane-1").join("id-1.reply")).unwrap();
        assert!(was_collected(dir.path(), "pane-1", "id-1"));
        // An id nobody ever answered has nothing outstanding either.
        assert!(was_collected(dir.path(), "pane-1", "never-written"));
    }

    #[test]
    fn an_answer_lands_in_the_pane_it_is_for_not_the_one_that_named_it() {
        // The correlation comes out of an envelope, and an envelope can name
        // any correlation its sender likes — including one another pane is
        // waiting on. The deck decides whose directory the answer goes in, so
        // a correlation aimed elsewhere reaches nobody.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pane-1", "borrowed-id", "mail for one").unwrap();
        assert!(dir.path().join("pane-1").join("borrowed-id.reply").exists());
        // pane-2 is waiting on that same id and hears nothing.
        assert!(!dir.path().join("pane-2").join("borrowed-id.reply").exists());
        assert!(!was_collected(dir.path(), "pane-1", "borrowed-id"));
        assert!(was_collected(dir.path(), "pane-2", "borrowed-id"));
    }

    #[test]
    fn discarding_removes_an_uncollected_answer_and_tolerates_a_collected_one() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pane-1", "id-2", "mail").unwrap();
        discard(dir.path(), "pane-1", "id-2");
        // The file itself, not `was_collected` — one broken function must not
        // be able to make the other's test pass.
        assert!(!dir.path().join("pane-1").join("id-2.reply").exists());
        // Idempotent: the common case is a hook that already took the file.
        discard(dir.path(), "pane-1", "id-2");
    }

    #[test]
    fn a_reply_lands_whole_and_out_of_the_watcher_s_way() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pane-1", "abc-123", "{\"block\":false}").unwrap();
        let path = dir.path().join("pane-1").join("abc-123.reply");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"block\":false}");
        // The inbox watcher only consumes `*.json`; a reply must not look
        // like an envelope arriving.
        assert_ne!(path.extension().unwrap(), "json");
        // And no staging file survives a successful publish.
        assert!(!dir.path().join("pane-1").join("abc-123.reply.tmp").exists());
    }

    #[test]
    fn ids_that_could_escape_the_run_directory_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("run-1");
        fs::create_dir(&run).unwrap();
        for hostile in ["../escaped", "..", "a/b", "", "with space", "nul\0byte"] {
            // Both halves of the path are checked: the correlation the asker
            // chose, and the pane id the deck resolved.
            assert!(
                write(&run, "pane-1", hostile, "x").is_err(),
                "must refuse correlation {hostile:?}"
            );
            assert!(
                write(&run, hostile, "id-1", "x").is_err(),
                "must refuse pane {hostile:?}"
            );
        }
        // Nothing was created anywhere, least of all outside the run dir.
        assert!(!root.path().join("escaped").exists());
        assert_eq!(fs::read_dir(&run).unwrap().count(), 0);
    }

    #[test]
    fn an_overlong_id_is_refused_before_it_reaches_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let long = "a".repeat(spool::MAX_NAME_LEN + 1);
        assert!(write(dir.path(), "pane-1", &long, "x").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_second_reply_for_the_same_id_replaces_the_first() {
        // A hook that retried, or a deck that changed its mind before the
        // hook read. Rename is atomic, so the reader sees one or the other
        // and never a mixture.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "pane-1", "id-1", "first").unwrap();
        write(dir.path(), "pane-1", "id-1", "second").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("pane-1").join("id-1.reply")).unwrap(),
            "second"
        );
    }
}
