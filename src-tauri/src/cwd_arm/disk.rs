//! A pane directory as KeepDeck touches it: one open handle on it, every
//! folder on the way reached by name without following a link, and each entry
//! observed — and changed — through the open folder that holds it, so a
//! folder swapped for a link on the way can refuse a step but never lead a
//! change somewhere else.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, ErrorKind};
use std::path::PathBuf;

use crate::fs_beneath::{self as fsb, Identity, Kind};

use super::proof;

/// The folder an entry sits in, reached — with the folders this reach made,
/// each by the identity it was made with.
pub(super) struct Way {
    pub dir: File,
    pub made: Vec<(String, Identity)>,
}

/// How far the way to an entry goes.
pub(super) enum Reach {
    Reached(Way),
    /// A folder on the way is not there: the entry is not either.
    Missing,
    /// A folder on the way is a file or a link (with where it points): the
    /// user's, unless proven otherwise, and nothing passes through it.
    Blocked {
        at: String,
        link: Option<PathBuf>,
    },
}

/// Reach the folder holding the last of `parts` from the open `cwd`, through
/// real folders only. With `make`, a missing folder is made — and recorded,
/// when its volume gives it an identity; one that does not is never taken
/// back.
pub(super) fn reach(cwd: &File, parts: &[String], make: bool) -> io::Result<Reach> {
    let mut dir = cwd.try_clone()?;
    let mut made = Vec::new();
    for (depth, part) in parts[..parts.len() - 1].iter().enumerate() {
        let name = OsStr::new(part);
        let at = parts[..=depth].join("/");
        match fsb::stat_at(&dir, name) {
            Ok(stat) if stat.kind == Kind::Dir => {}
            Ok(stat) if stat.kind == Kind::Link => {
                let link = PathBuf::from(fsb::read_link_at(&dir, name)?);
                return Ok(Reach::Blocked { at, link: Some(link) });
            }
            Ok(_) => return Ok(Reach::Blocked { at, link: None }),
            Err(e) if e.kind() == ErrorKind::NotFound && make => {
                fsb::make_dir_at(&dir, name, 0o777)?;
                if let Some(identity) = fsb::identity_at(&dir, name)? {
                    made.push((at, identity));
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Reach::Missing),
            Err(e) => return Err(e),
        }
        dir = fsb::open_at(&dir, name, libc::O_DIRECTORY)?;
    }
    Ok(Reach::Reached(Way { dir, made }))
}

/// What stands at one name in a folder, the name itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Slot {
    Absent,
    Link(PathBuf),
    /// A regular file: which one, and the digest of its bytes when they fit
    /// in `budget`.
    File {
        identity: Option<Identity>,
        digest: Option<String>,
    },
    /// A directory, a FIFO, a socket, a device.
    Other,
}

/// Observe `name` inside `dir`, reading a file's bytes no further than
/// `budget`.
pub(super) fn observe(dir: &File, name: &OsStr, budget: u64) -> io::Result<Slot> {
    let stat = match fsb::stat_at(dir, name) {
        Ok(stat) => stat,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Slot::Absent),
        Err(e) => return Err(e),
    };
    Ok(match stat.kind {
        Kind::Link => Slot::Link(PathBuf::from(fsb::read_link_at(dir, name)?)),
        Kind::File => {
            let identity = fsb::identity_at(dir, name)?;
            let digest = fsb::read_at(dir, name, budget)?.map(|bytes| proof::digest(&bytes));
            Slot::File { identity, digest }
        }
        Kind::Dir | Kind::Other => Slot::Other,
    })
}

/// Remove the folder `name` inside `dir` when it is still exactly the one
/// made as `identity` and holds nothing. Anything else — another folder in
/// its place, or one with entries now — stays: `Ok(false)`.
pub(super) fn remove_made_dir(dir: &File, name: &OsStr, identity: Identity) -> io::Result<bool> {
    match fsb::identity_at(dir, name) {
        Ok(Some(now)) if now == identity => {}
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    }
    match fsb::remove_at(dir, name, true) {
        Ok(()) => Ok(true),
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTEMPTY) | Some(libc::EEXIST)) => Ok(false),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn parts(path: &str) -> Vec<String> {
        path.split('/').map(String::from).collect()
    }

    #[test]
    fn the_way_goes_through_real_folders_only_and_makes_what_it_is_asked_to() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = fsb::open_dir(tmp.path()).unwrap();
        assert!(matches!(reach(&cwd, &parts(".agents/skills/x"), false).unwrap(), Reach::Missing));
        let Reach::Reached(way) = reach(&cwd, &parts(".agents/skills/x"), true).unwrap() else { panic!() };
        assert_eq!(way.made.iter().map(|(at, _)| at.as_str()).collect::<Vec<_>>(), [".agents", ".agents/skills"]);
        let Reach::Reached(again) = reach(&cwd, &parts(".agents/skills/x"), true).unwrap() else { panic!() };
        assert!(again.made.is_empty(), "nothing made twice");

        fs::remove_dir(tmp.path().join(".agents/skills")).unwrap();
        symlink("/elsewhere", tmp.path().join(".agents/skills")).unwrap();
        match reach(&cwd, &parts(".agents/skills/x"), true).unwrap() {
            Reach::Blocked { at, link } => {
                assert_eq!(at, ".agents/skills");
                assert_eq!(link, Some(PathBuf::from("/elsewhere")));
            }
            _ => panic!("a link on the way blocks it"),
        }
    }

    #[test]
    fn an_entry_is_observed_as_itself() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("f"), "bytes").unwrap();
        symlink("/t", tmp.path().join("l")).unwrap();
        fs::create_dir(tmp.path().join("d")).unwrap();
        let dir = fsb::open_dir(tmp.path()).unwrap();
        assert_eq!(observe(&dir, OsStr::new("gone"), 64).unwrap(), Slot::Absent);
        assert_eq!(observe(&dir, OsStr::new("l"), 64).unwrap(), Slot::Link(PathBuf::from("/t")));
        assert_eq!(observe(&dir, OsStr::new("d"), 64).unwrap(), Slot::Other);
        let Slot::File { identity, digest } = observe(&dir, OsStr::new("f"), 64).unwrap() else { panic!() };
        assert!(identity.is_some());
        assert_eq!(digest, Some(proof::digest(b"bytes")));
        let Slot::File { digest, .. } = observe(&dir, OsStr::new("f"), 2).unwrap() else { panic!() };
        assert_eq!(digest, None, "past the budget, unread");
    }

    #[test]
    fn only_the_folder_made_and_only_while_empty_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fsb::open_dir(tmp.path()).unwrap();
        fsb::make_dir_at(&dir, OsStr::new("made"), 0o777).unwrap();
        let made = fsb::identity_at(&dir, OsStr::new("made")).unwrap().unwrap();
        fs::write(tmp.path().join("made/theirs"), "x").unwrap();
        assert!(!remove_made_dir(&dir, OsStr::new("made"), made).unwrap(), "not while it holds something");
        fs::remove_file(tmp.path().join("made/theirs")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::remove_dir(tmp.path().join("made")).unwrap();
        fs::create_dir(tmp.path().join("made")).unwrap();
        assert!(!remove_made_dir(&dir, OsStr::new("made"), made).unwrap(), "an empty folder in its place is another");
        let now = fsb::identity_at(&dir, OsStr::new("made")).unwrap().unwrap();
        assert!(remove_made_dir(&dir, OsStr::new("made"), now).unwrap());
        assert!(!tmp.path().join("made").exists());
    }
}
