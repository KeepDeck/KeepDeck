//! The journal on disk: one file per entry in one folder, written atomically —
//! a temporary file, fsync, rename, fsync of the folder — so a file is the old
//! entry or the new one, never half of either. Each entry's file name and
//! format, and how boot reads the files back. What an entry holds is the
//! domain's ([`crate::domain::journal`]).

use crate::domain::ids::OpId;
use crate::domain::journal::Entry;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

/// The format of an entry. An entry of a newer format is never replayed.
pub const FORMAT: u32 = 1;

/// How much of an unreadable file goes to the log with it.
pub const RAW_LIMIT: usize = 4096;

#[derive(Serialize, Deserialize)]
struct OnDisk {
    format: u32,
    #[serde(flatten)]
    entry: Entry,
}

/// The file an operation's entry lives in.
fn file_name(op: OpId) -> String {
    format!("{op}.json")
}

fn op_of(name: &str) -> Option<OpId> {
    let digits = name.strip_prefix("op-")?.strip_suffix(".json")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().map(OpId)
}

fn encode(entry: &Entry) -> Vec<u8> {
    let on_disk = OnDisk { format: FORMAT, entry: entry.clone() };
    serde_json::to_vec_pretty(&on_disk).expect("an entry is plain data")
}

/// Why a file in the journal is not an entry to replay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unreadable {
    /// Not the file of an operation: `op-N.json` is the only name an entry has.
    StrayFile,
    /// Not an entry of any format.
    Corrupt(String),
    /// Written by a newer KeepDeck: after a downgrade it is never replayed.
    Newer(u32),
    /// The entry names another operation than its file.
    Misfiled(OpId),
}

/// The entry in `name`, or why it is not one.
fn decode(name: &str, bytes: &[u8]) -> Result<Entry, Unreadable> {
    let op = op_of(name).ok_or(Unreadable::StrayFile)?;
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| Unreadable::Corrupt(e.to_string()))?;
    let format = value
        .get("format")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| Unreadable::Corrupt("no format".into()))?;
    let format = u32::try_from(format).map_err(|_| Unreadable::Newer(u32::MAX))?;
    if format > FORMAT {
        return Err(Unreadable::Newer(format));
    }
    if format < FORMAT {
        return Err(Unreadable::Corrupt(format!("format {format} is not one this build reads")));
    }
    let on_disk: OnDisk = serde_json::from_value(value).map_err(|e| Unreadable::Corrupt(e.to_string()))?;
    if on_disk.entry.op != op {
        return Err(Unreadable::Misfiled(on_disk.entry.op));
    }
    Ok(on_disk.entry)
}

/// A file boot dropped: logged with its content, then removed — never
/// replayed, never kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub name: String,
    pub why: Unreadable,
    /// Its content, cut to [`RAW_LIMIT`] bytes.
    pub raw: String,
    /// Whether the file is gone; a failed removal is said, and boot goes on.
    pub removed: Result<(), String>,
}

/// What boot read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Loaded {
    pub entries: Vec<Entry>,
    pub dropped: Vec<Dropped>,
}

fn bounded(bytes: &[u8]) -> String {
    let head = &bytes[..bytes.len().min(RAW_LIMIT)];
    let text = String::from_utf8_lossy(head).into_owned();
    if bytes.len() > RAW_LIMIT {
        format!("{text}… ({} bytes in all)", bytes.len())
    } else {
        text
    }
}

/// The journal in one folder.
#[derive(Clone, Debug)]
pub struct DiskJournal {
    root: PathBuf,
    /// The lock file of the folder's claim. It lives in the same folder and
    /// is no entry: it is never read, dropped or removed. Its name is the
    /// claim's, handed in by whoever holds the claim.
    lock: String,
}

impl DiskJournal {
    pub fn new(root: PathBuf, lock: &str) -> DiskJournal {
        DiskJournal { root, lock: lock.to_owned() }
    }

    /// Write an operation's entry, whole, over the one it had.
    pub fn save(&self, entry: &Entry) -> io::Result<()> {
        let name = file_name(entry.op);
        let temp = self.root.join(format!(".{name}.tmp"));
        let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp)?;
        file.write_all(&encode(entry))?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, self.root.join(&name))?;
        self.sync_root()
    }

    /// Remove an operation's entry. Already gone is what a remove asks for.
    pub fn remove(&self, op: OpId) -> io::Result<()> {
        self.remove_file(&file_name(op))
    }

    /// Read the journal: every readable entry, in operation order; every
    /// other file dropped and removed.
    pub fn load(&self) -> io::Result<Loaded> {
        let mut loaded = Loaded::default();
        for (name, bytes) in self.files()? {
            match decode(&name, &bytes) {
                Ok(entry) => loaded.entries.push(entry),
                Err(why) => {
                    let removed = self.remove_file(&name).map_err(|e| e.to_string());
                    loaded.dropped.push(Dropped { raw: bounded(&bytes), name, why, removed });
                }
            }
        }
        loaded.entries.sort_by_key(|entry| entry.op);
        Ok(loaded)
    }

    /// Every file in the folder but the claim's lock, with its bytes.
    fn files(&self) -> io::Result<Vec<(String, Vec<u8>)>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            if name == self.lock {
                continue;
            }
            files.push((name, fs::read(entry.path())?));
        }
        files.sort();
        Ok(files)
    }

    fn remove_file(&self, name: &str) -> io::Result<()> {
        match fs::remove_file(self.root.join(name)) {
            Ok(()) => self.sync_root(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn sync_root(&self) -> io::Result<()> {
        File::open(&self.root)?.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::command::{Cmd, Command};
    use crate::domain::dir::Dir;
    use crate::domain::ids::{CommandId, PaneId, TeamId, WorkspaceId};
    use crate::domain::journal::{Removal, Sent, Step, Target, Work};
    use crate::domain::model::{Consent, Draft, Folder, SessionKey};

    /// The claim's lock file, as the app names it.
    const LOCK_FILE: &str = "lock";

    fn on_disk(dir: &std::path::Path) -> DiskJournal {
        DiskJournal::new(dir.to_path_buf(), LOCK_FILE)
    }
    use std::path::Path;

    fn ws() -> WorkspaceId {
        WorkspaceId("ws-a1".into())
    }

    fn disband(op: u64) -> Entry {
        let team = TeamId("team-b2".into());
        Entry {
            op: OpId(op),
            workspace: ws(),
            work: Work::Close {
                target: Target::Team { team: team.clone() },
                teams: vec![team.clone()],
                panes: vec![PaneId(3), PaneId(4)],
                consent: Consent {
                    stops: vec![PaneId(3), PaneId(4)],
                    folders: vec![Folder {
                        repo: Dir::new("/repo"),
                        path: Dir::new("/repo/wt"),
                        branch: Some("kd/a1/1".into()),
                    }],
                    tickets: vec![],
                },
                removals: vec![Removal {
                    repo: Dir::new("/repo"),
                    path: Dir::new("/repo/wt"),
                    branches: vec!["kd/a1/1".into()],
                }],
                space: Some(Dir::new("/repo/.git")),
            },
            joined: vec![],
            commands: vec![Sent {
                command: Command { id: CommandId { op: OpId(op), index: 0 }, cmd: Cmd::RemoveTeam { workspace: ws(), team } },
                settled: false,
                rejected: None,
            }],
            done: vec![Step::Checkout { path: Dir::new("/repo/wt") }],
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        names
    }

    #[test]
    fn an_entry_saved_is_read_back_whole_and_the_claim_lock_is_no_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LOCK_FILE), b"").unwrap();
        let journal = on_disk(dir.path());
        journal.save(&disband(5)).unwrap();
        assert_eq!(names(dir.path()), [LOCK_FILE, "op-5.json"], "no temporary file is left");
        let loaded = journal.load().unwrap();
        assert_eq!(loaded.entries, [disband(5)]);
        assert!(loaded.dropped.is_empty(), "the lock is not a stray: {:?}", loaded.dropped);
        assert!(dir.path().join(LOCK_FILE).exists());
    }

    #[test]
    fn a_fork_entry_without_its_discard_yet_reads_back() {
        let entry = Entry {
            op: OpId(2),
            workspace: ws(),
            work: Work::Fork {
                pane: PaneId(8),
                source: SessionKey { agent: "claude".into(), session: "s".into() },
                team: None,
                ticket: None,
                discard: None,
            },
            joined: vec![],
            commands: vec![],
            done: vec![],
        };
        assert_eq!(decode("op-2.json", &encode(&entry)), Ok(entry));
    }

    /// A fork interrupted before the update keeps its rollback: an entry a
    /// build wrote before the continuation commands carried their ask's
    /// draft reads back, each with none.
    #[test]
    fn an_entry_written_before_the_continuation_commands_carried_a_draft_reads_back() {
        let source = SessionKey { agent: "claude".into(), session: "s".into() };
        let sent = |index: u32, cmd: Cmd| Sent { command: Command { id: CommandId { op: OpId(4), index }, cmd }, settled: false, rejected: None };
        let entry = Entry {
            op: OpId(4),
            workspace: ws(),
            work: Work::Fork { pane: PaneId(8), source: source.clone(), team: None, ticket: None, discard: None },
            joined: vec![],
            commands: vec![
                sent(0, Cmd::Fork { workspace: ws(), pane: PaneId(8), source: source.clone(), cwd: Dir::new("/repo"), draft: Draft::default() }),
                sent(1, Cmd::PrepareResume { workspace: ws(), pane: PaneId(9), source, draft: Draft::default() }),
            ],
            done: vec![],
        };
        let mut written: serde_json::Value = serde_json::from_slice(&encode(&entry)).unwrap();
        for sent in written["commands"].as_array_mut().unwrap() {
            let cmd = sent["command"]["cmd"].as_object_mut().unwrap();
            assert!(cmd.remove("draft").is_some(), "the field this pin is about is written today");
        }
        assert_eq!(decode("op-4.json", &serde_json::to_vec(&written).unwrap()), Ok(entry));
    }

    #[test]
    fn a_corrupt_entry_is_dropped_with_its_content_and_removed_never_replayed() {
        let dir = tempfile::tempdir().unwrap();
        let journal = on_disk(dir.path());
        journal.save(&disband(1)).unwrap();
        fs::write(dir.path().join("op-2.json"), b"{\"format\": 1, \"op\": 2, \"work\": ").unwrap();
        let loaded = journal.load().unwrap();
        assert_eq!(loaded.entries.iter().map(|entry| entry.op).collect::<Vec<_>>(), [OpId(1)]);
        let [dropped] = loaded.dropped.as_slice() else { panic!("one dropped: {:?}", loaded.dropped) };
        assert_eq!(dropped.name, "op-2.json");
        assert!(matches!(dropped.why, Unreadable::Corrupt(_)));
        assert!(dropped.raw.starts_with("{\"format\": 1"), "the content goes to the log");
        assert_eq!(dropped.removed, Ok(()));
        assert_eq!(names(dir.path()), ["op-1.json"], "no .corrupt file is kept");
    }

    #[test]
    fn an_entry_of_a_newer_build_is_dropped_never_replayed() {
        let mut bytes: serde_json::Value = serde_json::from_slice(&encode(&disband(3))).unwrap();
        bytes["format"] = serde_json::json!(FORMAT + 1);
        let bytes = serde_json::to_vec(&bytes).unwrap();
        assert_eq!(decode("op-3.json", &bytes), Err(Unreadable::Newer(FORMAT + 1)));
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("op-3.json"), &bytes).unwrap();
        let loaded = on_disk(dir.path()).load().unwrap();
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.dropped[0].why, Unreadable::Newer(FORMAT + 1));
        assert!(names(dir.path()).is_empty());
    }

    #[test]
    fn a_stray_file_or_an_entry_in_another_operations_file_is_dropped() {
        assert_eq!(decode(".op-1.json.tmp", &encode(&disband(1))), Err(Unreadable::StrayFile), "a write cut short");
        assert_eq!(decode("op-1.json", &encode(&disband(9))), Err(Unreadable::Misfiled(OpId(9))));
        assert!(matches!(decode("op-1.json", b"{\"op\": 1}"), Err(Unreadable::Corrupt(_))), "no format");
    }

    #[test]
    fn a_save_cut_short_leaves_the_old_entry_and_boot_removes_the_stray() {
        let dir = tempfile::tempdir().unwrap();
        let journal = on_disk(dir.path());
        journal.save(&disband(4)).unwrap();
        // A crash between the temporary file and the rename.
        fs::write(dir.path().join(".op-4.json.tmp"), b"{\"format\": 1, \"op\":").unwrap();
        let loaded = journal.load().unwrap();
        assert_eq!(loaded.entries, [disband(4)], "the old entry, whole");
        assert_eq!(loaded.dropped.len(), 1);
        assert_eq!(names(dir.path()), ["op-4.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_be_removed_is_still_dropped_and_said() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("op-4.json"), b"not json").unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let loaded = on_disk(dir.path()).load();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let loaded = loaded.unwrap();
        assert!(loaded.dropped[0].removed.is_err(), "{:?}", loaded.dropped);
        assert!(loaded.entries.is_empty());
    }

    #[test]
    fn the_content_that_goes_to_the_log_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("op-6.json"), vec![b'x'; RAW_LIMIT * 2]).unwrap();
        let raw = &on_disk(dir.path()).load().unwrap().dropped[0].raw;
        assert!(raw.len() < RAW_LIMIT + 64);
        assert!(raw.ends_with(&format!("({} bytes in all)", RAW_LIMIT * 2)));
    }

    #[test]
    fn entries_load_in_operation_order() {
        let dir = tempfile::tempdir().unwrap();
        let journal = on_disk(dir.path());
        for op in [12, 3, 7] {
            journal.save(&disband(op)).unwrap();
        }
        let ops: Vec<_> = journal.load().unwrap().entries.iter().map(|entry| entry.op).collect();
        assert_eq!(ops, [OpId(3), OpId(7), OpId(12)]);
    }

    #[test]
    fn removing_what_is_gone_is_done() {
        let dir = tempfile::tempdir().unwrap();
        let journal = on_disk(dir.path());
        journal.save(&disband(9)).unwrap();
        journal.remove(OpId(9)).unwrap();
        assert!(names(dir.path()).is_empty());
        journal.remove(OpId(9)).unwrap();
    }

    /// The file left alone is the one the claim names: it is kept and never
    /// read, and a file that is merely called "lock" is a stray like any
    /// other.
    #[test]
    fn the_lock_left_alone_is_the_one_the_claim_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("claim.lock"), b"").unwrap();
        fs::write(dir.path().join("lock"), b"").unwrap();
        let loaded = DiskJournal::new(dir.path().to_path_buf(), "claim.lock").load().unwrap();
        assert_eq!(loaded.dropped.iter().map(|dropped| dropped.name.as_str()).collect::<Vec<_>>(), ["lock"]);
        assert_eq!(names(dir.path()), ["claim.lock"]);
    }
}
