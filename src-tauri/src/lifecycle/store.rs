//! The journal on disk: one file per entry in `<home>/lifecycle/`, written
//! atomically — a temporary file, fsync, rename, fsync of the folder — so a
//! file is the old entry or the new one, never half of either.

use keepdeck_lifecycle::journal::JournalStore;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The claim's lock file lives in the same folder; it is not an entry.
const LOCK_FILE: &str = "lock";

#[derive(Clone, Debug)]
pub struct DiskJournal {
    root: PathBuf,
}

impl DiskJournal {
    pub fn new(root: PathBuf) -> DiskJournal {
        DiskJournal { root }
    }

    fn sync_root(&self) -> io::Result<()> {
        File::open(&self.root)?.sync_all()
    }
}

/// A name the store writes or removes: a plain file name, inside the root.
fn plain(name: &str) -> io::Result<&Path> {
    let path = Path::new(name);
    let plain = path.components().count() == 1 && path.file_name().is_some() && name != LOCK_FILE;
    if plain {
        Ok(path)
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidInput, format!("not a journal file name: {name:?}")))
    }
}

impl JournalStore for DiskJournal {
    type Error = io::Error;

    fn files(&mut self) -> io::Result<Vec<(String, Vec<u8>)>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            if name == LOCK_FILE {
                continue;
            }
            files.push((name, fs::read(entry.path())?));
        }
        files.sort();
        Ok(files)
    }

    fn write(&mut self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let target = self.root.join(plain(name)?);
        let temp = self.root.join(format!(".{name}.tmp"));
        let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &target)?;
        self.sync_root()
    }

    fn remove(&mut self, name: &str) -> io::Result<()> {
        match fs::remove_file(self.root.join(plain(name)?)) {
            Ok(()) => self.sync_root(),
            // Already gone is what a remove asks for.
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepdeck_lifecycle::journal::{self, Entry, Work};
    use keepdeck_lifecycle::ids::{OpId, WorkspaceId};
    use keepdeck_lifecycle::dir::Dir;

    fn entry(op: u64) -> Entry {
        Entry {
            op: OpId(op),
            workspace: WorkspaceId("ws-a".into()),
            work: Work::RemoveUnheld { path: Dir::new("/wt/x"), tag: None, repo: Some(Dir::new("/repo")) },
            joined: vec![],
            commands: vec![],
            done: vec![],
        }
    }

    #[test]
    fn an_entry_written_is_read_back_whole_and_the_claim_lock_is_no_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LOCK_FILE), b"").unwrap();
        let mut store = DiskJournal::new(dir.path().to_path_buf());
        store.write(&journal::file_name(OpId(3)), &journal::encode(&entry(3))).unwrap();
        let loaded = journal::load(&mut store).unwrap();
        assert_eq!(loaded.entries, [entry(3)]);
        assert!(loaded.dropped.is_empty(), "the lock is not a stray: {:?}", loaded.dropped);
        assert!(dir.path().join(LOCK_FILE).exists());
        assert!(!dir.path().join(".op-3.json.tmp").exists(), "no temporary file is left");
    }

    #[test]
    fn a_write_cut_short_leaves_the_old_entry_and_a_stray_boot_removes() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DiskJournal::new(dir.path().to_path_buf());
        store.write("op-4.json", &journal::encode(&entry(4))).unwrap();
        // A crash between the temporary file and the rename.
        fs::write(dir.path().join(".op-4.json.tmp"), b"{\"format\": 1, \"op\":").unwrap();
        let loaded = journal::load(&mut store).unwrap();
        assert_eq!(loaded.entries, [entry(4)], "the old entry, whole");
        assert_eq!(loaded.dropped.len(), 1);
        assert!(!dir.path().join(".op-4.json.tmp").exists());
    }

    #[test]
    fn removing_what_is_gone_is_done_and_names_outside_the_root_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DiskJournal::new(dir.path().to_path_buf());
        store.remove("op-9.json").unwrap();
        assert!(store.write("../op-1.json", b"x").is_err());
        assert!(store.remove(LOCK_FILE).is_err(), "the claim's lock is never removed");
    }
}
