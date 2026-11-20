//! The journal of unfinished work: one entry per operation with a step that
//! cannot be taken back, on disk before that step, removed once every step is
//! done and its last deck command is saved. Empty in normal running.
//!
//! An entry is self-sufficient: the tail of its operation needs nothing else —
//! not the deck, not the sessions of the launch that wrote it. This module
//! holds the entry, its codec and the port of the store; writing to disk is
//! the store's, in the app.

use crate::command::{Command, Why};
use crate::dir::Dir;
use crate::ids::{OpId, PaneId, TeamId, WorkspaceId};
use crate::model::{Consent, SessionKey};
use serde::{Deserialize, Serialize};

/// The format of an entry. An entry of a newer format is never replayed.
pub const FORMAT: u32 = 1;

/// How much of an unreadable file goes to the log with it.
pub const RAW_LIMIT: usize = 4096;

/// The worktree a creation makes: written before `git worktree add`, so a
/// checkout found there after a crash is this ticket's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub repo: Dir,
    pub path: Dir,
    pub branch: String,
    pub base: Option<String>,
}

/// What a Close ends.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Agent { pane: PaneId },
    Team { team: TeamId },
    Workspace,
}

/// The plan for removing one worktree, written before its first step: the
/// checkout, and the branches born in it — read from its reflog, which git
/// erases with the checkout. Whether a branch is still somebody's is git's
/// word at the moment of its deletion, not the plan's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Removal {
    pub repo: Dir,
    pub path: Dir,
    pub branches: Vec<String>,
}

/// One step of an operation's tail that is done. What is not done yet is the
/// plan minus these; a failed step stays undone and is retried at every launch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    Checkout { path: Dir },
    Branch { repo: Dir, name: String },
    /// The plantings taken out of a folder.
    Disarm { dir: Dir },
    /// The workspace's data in the stores of Rust removed.
    Stores,
    /// A folder's HEAD kept as the tag `name` before it goes.
    Tag { path: Dir, name: String },
    /// The fork's scaffolding removed.
    Discard,
}

/// What a fork's hook said to remove when its fork does not finish. Paths of
/// the plugin's own store, removed as the plugin: no launch arguments, no
/// secrets.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub struct Discard {
    pub plugin: String,
    /// What is removed once the launch is bound, and on any rollback.
    pub once_started: Vec<String>,
    /// What is removed only by a rollback: the copy itself.
    pub if_never_started: Vec<String>,
}

/// The operation an entry keeps, with its frozen inputs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Work {
    /// A team whose worktree a ticket creates — a creation, its Retry.
    Create { team: TeamId, ticket: Ticket },
    /// A Close, with its membership as final as the ops before it left it.
    Close {
        target: Target,
        teams: Vec<TeamId>,
        panes: Vec<PaneId>,
        consent: Consent,
        removals: Vec<Removal>,
        /// The repository its branch names are unique within: what they are
        /// held against while its cleanup is owed, its workspace gone or not.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space: Option<Dir>,
    },
    Archive { panes: Vec<PaneId> },
    /// The repository is the one taken when it was accepted: it needs no
    /// workspace row to finish. Absent only from an entry written before.
    RemoveUnheld {
        path: Dir,
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<Dir>,
    },
    /// A conversation carried into a new pane. Open until the pane's launch is
    /// bound to it: an open fork at boot did not finish, and is rolled back.
    Fork {
        pane: PaneId,
        source: SessionKey,
        /// The team made for the fork, if it made one.
        team: Option<TeamId>,
        ticket: Option<Ticket>,
        /// Known once the hook's result is accepted.
        discard: Option<Discard>,
    },
}

/// The commands to data owners an operation's tail needs, with whether each
/// is settled (a deck command: durable or rejected) — and, for one its owner
/// refused, the owner's reason, so a restore does not take a refusal for an
/// application.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    pub command: Command,
    pub settled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<Why>,
}

/// One operation's entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub op: OpId,
    pub workspace: WorkspaceId,
    pub work: Work,
    /// Operations this one joined and waits for — a workspace close that
    /// joined a disband already under way names it here before its first
    /// step.
    #[serde(default)]
    pub joined: Vec<OpId>,
    #[serde(default)]
    pub commands: Vec<Sent>,
    #[serde(default)]
    pub done: Vec<Step>,
}

#[derive(Serialize, Deserialize)]
struct OnDisk {
    format: u32,
    #[serde(flatten)]
    entry: Entry,
}

/// The file an operation's entry lives in.
pub fn file_name(op: OpId) -> String {
    format!("{op}.json")
}

fn op_of(name: &str) -> Option<OpId> {
    let digits = name.strip_prefix("op-")?.strip_suffix(".json")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().map(OpId)
}

/// The bytes of an entry, as the store writes them.
pub fn encode(entry: &Entry) -> Vec<u8> {
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
pub fn decode(name: &str, bytes: &[u8]) -> Result<Entry, Unreadable> {
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

/// The store of the journal: one file per entry in one folder. Writes are
/// atomic — a temporary file, fsync, rename, fsync of the folder — so a file
/// is either the old entry or the new one.
pub trait JournalStore {
    type Error: std::fmt::Display;
    /// Every file in the journal's folder, with its bytes.
    fn files(&mut self) -> Result<Vec<(String, Vec<u8>)>, Self::Error>;
    fn write(&mut self, name: &str, bytes: &[u8]) -> Result<(), Self::Error>;
    fn remove(&mut self, name: &str) -> Result<(), Self::Error>;
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

impl Loaded {
    /// Joins that name an operation with no readable entry: its parent counts
    /// it done once the deck shows its target gone, and never takes its
    /// folders or its consent.
    pub fn dangling_joins(&self) -> Vec<(OpId, OpId)> {
        let known: std::collections::BTreeSet<OpId> = self.entries.iter().map(|entry| entry.op).collect();
        self.entries
            .iter()
            .flat_map(|entry| entry.joined.iter().filter(|child| !known.contains(child)).map(|&child| (entry.op, child)))
            .collect()
    }
}

/// Read the journal: every readable entry, in operation order; every other
/// file dropped and removed.
pub fn load<S: JournalStore>(store: &mut S) -> Result<Loaded, S::Error> {
    let mut loaded = Loaded::default();
    for (name, bytes) in store.files()? {
        match decode(&name, &bytes) {
            Ok(entry) => loaded.entries.push(entry),
            Err(why) => {
                let removed = store.remove(&name).map_err(|e| e.to_string());
                loaded.dropped.push(Dropped { raw: bounded(&bytes), name, why, removed });
            }
        }
    }
    loaded.entries.sort_by_key(|entry| entry.op);
    Ok(loaded)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Cmd;
    use crate::ids::CommandId;
    use crate::model::Folder;
    use std::collections::BTreeMap;

    /// A store in memory, as the app's adapter behaves: a write replaces the
    /// file whole.
    #[derive(Default)]
    struct Memory {
        files: BTreeMap<String, Vec<u8>>,
        refuse_remove: bool,
    }

    impl JournalStore for Memory {
        type Error = String;
        fn files(&mut self) -> Result<Vec<(String, Vec<u8>)>, String> {
            Ok(self.files.iter().map(|(name, bytes)| (name.clone(), bytes.clone())).collect())
        }
        fn write(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
            self.files.insert(name.into(), bytes.into());
            Ok(())
        }
        fn remove(&mut self, name: &str) -> Result<(), String> {
            if self.refuse_remove {
                return Err("read-only".into());
            }
            self.files.remove(name);
            Ok(())
        }
    }

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

    fn save(store: &mut Memory, entry: &Entry) {
        store.write(&file_name(entry.op), &encode(entry)).unwrap();
    }

    #[test]
    fn an_entry_reads_back_as_it_was_written() {
        let mut store = Memory::default();
        let entry = disband(5);
        save(&mut store, &entry);
        assert_eq!(store.files.keys().collect::<Vec<_>>(), ["op-5.json"]);
        let loaded = load(&mut store).unwrap();
        assert_eq!(loaded.entries, [entry]);
        assert!(loaded.dropped.is_empty());
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

    #[test]
    fn a_corrupt_entry_is_dropped_with_its_content_and_removed_never_replayed() {
        let mut store = Memory::default();
        save(&mut store, &disband(1));
        store.write("op-2.json", b"{\"format\": 1, \"op\": 2, \"work\": ").unwrap();
        let loaded = load(&mut store).unwrap();
        assert_eq!(loaded.entries.iter().map(|entry| entry.op).collect::<Vec<_>>(), [OpId(1)]);
        let [dropped] = loaded.dropped.as_slice() else { panic!("one dropped: {:?}", loaded.dropped) };
        assert_eq!(dropped.name, "op-2.json");
        assert!(matches!(dropped.why, Unreadable::Corrupt(_)));
        assert!(dropped.raw.starts_with("{\"format\": 1"), "the content goes to the log");
        assert_eq!(dropped.removed, Ok(()));
        assert!(!store.files.contains_key("op-2.json"), "no .corrupt file is kept");
    }

    #[test]
    fn an_entry_of_a_newer_build_is_dropped_never_replayed() {
        let mut bytes: serde_json::Value = serde_json::from_slice(&encode(&disband(3))).unwrap();
        bytes["format"] = serde_json::json!(FORMAT + 1);
        let bytes = serde_json::to_vec(&bytes).unwrap();
        assert_eq!(decode("op-3.json", &bytes), Err(Unreadable::Newer(FORMAT + 1)));
        let mut store = Memory::default();
        store.write("op-3.json", &bytes).unwrap();
        let loaded = load(&mut store).unwrap();
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.dropped[0].why, Unreadable::Newer(FORMAT + 1));
        assert!(store.files.is_empty());
    }

    #[test]
    fn a_stray_file_or_an_entry_in_another_operations_file_is_dropped() {
        assert_eq!(decode(".op-1.json.tmp", &encode(&disband(1))), Err(Unreadable::StrayFile), "a write cut short");
        assert_eq!(decode("op-1.json", &encode(&disband(9))), Err(Unreadable::Misfiled(OpId(9))));
        assert!(matches!(decode("op-1.json", b"{\"op\": 1}"), Err(Unreadable::Corrupt(_))), "no format");
    }

    #[test]
    fn a_file_that_cannot_be_removed_is_still_dropped_and_said() {
        let mut store = Memory { refuse_remove: true, ..Memory::default() };
        store.files.insert("op-4.json".into(), b"not json".to_vec());
        let loaded = load(&mut store).unwrap();
        assert_eq!(loaded.dropped[0].removed, Err("read-only".into()));
        assert!(loaded.entries.is_empty());
    }

    #[test]
    fn the_content_that_goes_to_the_log_is_bounded() {
        let mut store = Memory::default();
        store.files.insert("op-6.json".into(), vec![b'x'; RAW_LIMIT * 2]);
        let raw = &load(&mut store).unwrap().dropped[0].raw;
        assert!(raw.len() < RAW_LIMIT + 64);
        assert!(raw.ends_with(&format!("({} bytes in all)", RAW_LIMIT * 2)));
    }

    #[test]
    fn entries_load_in_operation_order() {
        let mut store = Memory::default();
        for op in [12, 3, 7] {
            save(&mut store, &disband(op));
        }
        let ops: Vec<_> = load(&mut store).unwrap().entries.iter().map(|entry| entry.op).collect();
        assert_eq!(ops, [OpId(3), OpId(7), OpId(12)]);
    }

    #[test]
    fn a_join_naming_an_entry_that_did_not_load_is_dangling() {
        let mut store = Memory::default();
        let mut workspace_close = disband(10);
        workspace_close.work = Work::Close {
            target: Target::Workspace,
            teams: vec![],
            panes: vec![],
            consent: Consent::default(),
            removals: vec![],
            space: None,
        };
        workspace_close.joined = vec![OpId(4), OpId(5)];
        save(&mut store, &workspace_close);
        save(&mut store, &disband(4));
        store.files.insert("op-5.json".into(), b"broken".to_vec());
        let loaded = load(&mut store).unwrap();
        assert_eq!(loaded.dangling_joins(), [(OpId(10), OpId(5))], "the readable child is no dangling join");
    }
}
