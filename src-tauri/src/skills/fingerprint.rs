//! What a staged view holds, said in one line: a digest of every entry in it —
//! its path, whether it is a folder, a file or a runnable file, and a file's
//! bytes — written into the view as its own last file.
//!
//! A copy of the view carries that file along with what it describes, so a
//! copy says by itself what it holds: a plugin that published one leaves it
//! as it is while the view it came from says the same.
//!
//! Content, never metadata: a stage rewrites every file of the view, so no
//! time or inode of it means anything, and an edit that keeps a file's size
//! and time is still an edit.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, ErrorKind, Read as _};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::tree::Allowance;
use crate::fs_beneath::{self as fsb, Kind};

/// The view's own file holding its fingerprint, at its top (plugin-api's
/// `VIEW_FINGERPRINT_FILE`: a plugin reads it there and in its copies).
pub(super) const FINGERPRINT_FILE: &str = ".keepdeck-fingerprint";

const PREFIX: &str = "sha256:";

/// What the fingerprint file takes from a view: itself, and its text.
pub(super) const FINGERPRINT_COST: Allowance = Allowance { entries: 1, bytes: (PREFIX.len() + 64) as u64 };

/// The fingerprint of the view `dir`: of every entry in it but the
/// fingerprint file itself.
pub(super) fn of_view(dir: &Path) -> io::Result<String> {
    let root = fsb::open_dir(dir)?;
    let mut digest = Sha256::new();
    take_in(&root, &mut Vec::new(), &mut digest)?;
    Ok(format!("{PREFIX}{:x}", digest.finalize()))
}

/// Every entry of the open folder `dir`, at `at` inside the view, in name
/// order. Each one is its kind, its path ended by a NUL no name holds, and —
/// for a file — its length before its bytes: no two views read the same.
fn take_in(dir: &File, at: &mut Vec<OsString>, digest: &mut Sha256) -> io::Result<()> {
    for name in fsb::names_in(dir)? {
        if at.is_empty() && name == FINGERPRINT_FILE {
            continue;
        }
        let stat = fsb::stat_at(dir, &name)?;
        at.push(name);
        let name = at.last().expect("just pushed");
        let kind = match stat.kind {
            Kind::Dir => b'd',
            Kind::File if stat.runnable => b'x',
            Kind::File => b'f',
            Kind::Link | Kind::Other => {
                return Err(io::Error::new(ErrorKind::InvalidData, "a staged view holds only folders and files"));
            }
        };
        digest.update([kind]);
        for (n, part) in at.iter().enumerate() {
            if n > 0 {
                digest.update(b"/");
            }
            digest.update(part.as_bytes());
        }
        digest.update([0]);
        if stat.kind == Kind::Dir {
            let sub = fsb::open_at(dir, name, libc::O_DIRECTORY)?;
            take_in(&sub, at, digest)?;
        } else {
            let file = fsb::open_at(dir, name, libc::O_NONBLOCK)?;
            digest.update(stat.len.to_le_bytes());
            let read = io::copy(&mut (&file).take(stat.len), digest)?;
            if read != stat.len {
                return Err(io::Error::new(ErrorKind::InvalidData, "a staged file changed while it was read"));
            }
        }
        at.pop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;

    /// A view holding `files` (path → text), each made on its own.
    fn view(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("skills");
        fs::create_dir(&dir).unwrap();
        for (path, text) in files {
            let path = dir.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        (tmp, dir)
    }

    fn of(files: &[(&str, &str)]) -> String {
        let (_tmp, dir) = view(files);
        of_view(&dir).unwrap()
    }

    #[test]
    fn the_same_content_has_the_same_fingerprint_however_it_was_made() {
        let files = [("review/SKILL.md", "---\ndescription: r\n---\n"), ("review/lib/x.txt", "x")];
        let first = of(&files);
        assert!(first.starts_with("sha256:") && first.len() as u64 == FINGERPRINT_COST.bytes, "{first}");
        // Made again, in another folder, at another time.
        assert_eq!(of(&files), first);
    }

    #[test]
    fn every_kind_of_change_is_a_new_fingerprint() {
        let base = of(&[("a/SKILL.md", "one"), ("a/lib/x", "xy")]);
        let changes = [
            // The same length, other bytes.
            of(&[("a/SKILL.md", "two"), ("a/lib/x", "xy")]),
            // The same bytes under another name.
            of(&[("a/SKILL.md", "one"), ("a/lib/y", "xy")]),
            // The same names and bytes, split otherwise between two files.
            of(&[("a/SKILL.md", "onex"), ("a/lib/x", "y")]),
            // The same file, one folder up.
            of(&[("a/SKILL.md", "one"), ("a/x", "xy")]),
        ];
        for (n, changed) in changes.iter().enumerate() {
            assert_ne!(*changed, base, "change {n}");
        }

        let (_tmp, dir) = view(&[("a/SKILL.md", "one"), ("a/lib/x", "xy")]);
        fs::create_dir(dir.join("a/empty")).unwrap();
        assert_ne!(of_view(&dir).unwrap(), base, "an empty folder is part of the view");
        fs::remove_dir(dir.join("a/empty")).unwrap();
        assert_eq!(of_view(&dir).unwrap(), base);
        fs::set_permissions(dir.join("a/lib/x"), fs::Permissions::from_mode(0o700)).unwrap();
        assert_ne!(of_view(&dir).unwrap(), base, "a file made runnable");
    }

    #[test]
    fn a_file_whose_bytes_look_like_the_next_entry_is_not_taken_for_two() {
        // Read as one stream, `a/1` holding "X", then a file `a/2` holding
        // "Y", is the same bytes as `a/1` holding all of it: only a file's
        // length before its bytes keeps the two views apart.
        let two = of(&[("a/1", "X"), ("a/2", "Y")]);
        let one = of(&[("a/1", "Xfa/2\0Y")]);
        assert_ne!(one, two);
    }

    #[test]
    fn the_fingerprint_file_is_not_part_of_what_it_says() {
        let (_tmp, dir) = view(&[("a/SKILL.md", "one")]);
        let before = of_view(&dir).unwrap();
        fs::write(dir.join(FINGERPRINT_FILE), &before).unwrap();
        assert_eq!(of_view(&dir).unwrap(), before);
        // Only at the top: a file of that name inside a skill is the skill's.
        fs::write(dir.join("a").join(FINGERPRINT_FILE), "mine").unwrap();
        assert_ne!(of_view(&dir).unwrap(), before);
    }

    /// The file's name is a contract with `@keepdeck/plugin-api`, which reads
    /// it in a view and in every copy of one: renamed on one side alone, no
    /// copy would ever be taken for current again, and nothing would say so.
    #[test]
    fn the_file_name_matches_the_plugin_api_contract() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/plugin-api/src/context/publish.ts");
        let source = fs::read_to_string(&path).expect("publish.ts is readable");
        assert!(
            source.contains(&format!("export const VIEW_FINGERPRINT_FILE = \"{FINGERPRINT_FILE}\";")),
            "publish.ts names the view's fingerprint file otherwise"
        );
    }

    #[test]
    fn a_view_holding_a_link_has_no_fingerprint() {
        let (_tmp, dir) = view(&[("a/SKILL.md", "one")]);
        symlink("SKILL.md", dir.join("a/alias")).unwrap();
        assert!(of_view(&dir).is_err());
    }
}
