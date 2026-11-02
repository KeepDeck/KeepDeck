//! What a skill is made of: its SKILL.md, and the files staging copies beside
//! it for an agent — read beneath the skill's own folder.
//!
//! A skill is whatever its author put in its folder, and every agent gets a
//! copy, so the copy decides what comes along:
//! - a link is followed only while it stays inside the skill; one that leads
//!   out of it, points at nothing, or leads back into a folder it sits in is
//!   left out;
//! - anything that is neither a file nor a folder (a FIFO, a socket) is left
//!   out, and never waited on;
//! - a copy carries no more than the allowance it is given, and a tree that
//!   holds more leaves nothing behind — what it becomes then is the caller's.
//!
//! What is left out is named by its path inside the skill, so the user can
//! fix it. Every entry looked at costs the allowance one, copied or not, so a
//! folder of a million dangling links is as bounded as one of a million files.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, ErrorKind, Read as _};
use std::path::{Component, Path, PathBuf};

use super::library::SKILL_FILE;
use crate::fs_beneath::{self as fsb, Kind, Stat, COPY_MAX_BYTES, COPY_MAX_ENTRIES};

/// An amount of a copy: entries (folders and files) and file bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Allowance {
    pub entries: usize,
    pub bytes: u64,
}

impl Allowance {
    /// A skill that is nothing but its SKILL.md: the folder and the file.
    pub fn bare(content: &str) -> Self {
        Self { entries: 2, bytes: content.len() as u64 }
    }

    pub fn covers(self, cost: Self) -> bool {
        cost.entries <= self.entries && cost.bytes <= self.bytes
    }

    pub fn less(self, cost: Self) -> Self {
        Self {
            entries: self.entries.saturating_sub(cost.entries),
            bytes: self.bytes.saturating_sub(cost.bytes),
        }
    }

    pub fn min(self, other: Self) -> Self {
        Self { entries: self.entries.min(other.entries), bytes: self.bytes.min(other.bytes) }
    }
}

/// A whole staged view: exactly what one tree copy may carry, so a plugin's
/// copy of the view is never refused for its size.
pub(super) const VIEW_MAX: Allowance = Allowance { entries: COPY_MAX_ENTRIES, bytes: COPY_MAX_BYTES };

/// One skill, its folder and SKILL.md included: an eighth of a view, so no one
/// skill can crowd the others out of theirs.
pub(super) const SKILL_MAX: Allowance = Allowance { entries: COPY_MAX_ENTRIES / 8, bytes: COPY_MAX_BYTES / 8 };

/// The largest SKILL.md read: a skill's text, never a data file.
pub(super) const SKILL_FILE_MAX_BYTES: u64 = 1024 * 1024;

/// How many links one link may lead through before it is taken for a loop.
const MAX_HOPS: usize = 40;

/// A skill folder's SKILL.md as text. `Ok(None)`: the folder holds none, so it
/// is no skill. An error: it holds one nobody should read — a link, something
/// that is no file, more than [`SKILL_FILE_MAX_BYTES`], not UTF-8 — or the
/// folder is itself a link now.
pub(super) fn read_skill_file(skill: &Path) -> io::Result<Option<String>> {
    let folder = match fsb::open_dir(skill) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    let file = match fsb::open_at(&folder, OsStr::new(SKILL_FILE), libc::O_NONBLOCK) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    let refuse = |why: &str| Err(io::Error::new(ErrorKind::InvalidData, format!("{SKILL_FILE} {why}")));
    let stat = fsb::stat_of(&file)?;
    if stat.kind != Kind::File {
        return refuse("is not a file");
    }
    let mut bytes = Vec::new();
    (&file).take(SKILL_FILE_MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if stat.len > SKILL_FILE_MAX_BYTES || bytes.len() as u64 > SKILL_FILE_MAX_BYTES {
        return refuse(&format!("is larger than {SKILL_FILE_MAX_BYTES} bytes"));
    }
    String::from_utf8(bytes).map(Some).or_else(|_| refuse("is not UTF-8 text"))
}

/// Why something inside a skill was left out of its copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Why {
    /// A link that leads out of the skill (absolute, or up past its folder).
    LinkOut,
    /// A link that points at nothing.
    LinkDangles,
    /// A link back into a folder it sits in, or a chain of links that never
    /// ends.
    LinkCycle,
    /// Neither a file nor a folder.
    Special,
    /// Something that could not be read.
    Unreadable,
    /// A name the copy holds already: another entry's, which the volume the
    /// copy is made on takes for the same.
    NameTaken,
    /// A path too long for the volume the copy is made on.
    PathTooLong,
}

/// Something a copy left out, by its path inside the skill's folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LeftOut {
    pub path: PathBuf,
    pub why: Why,
}

/// What [`copy_tree`] made of a skill.
#[derive(Debug)]
pub(super) enum TreeCopy {
    /// Copied: what it took from the allowance, and what it left out.
    Copied { used: Allowance, left_out: Vec<LeftOut> },
    /// The tree holds more than the allowance; nothing of it is left behind.
    TooBig,
    /// The skill's folder is gone, or is no folder any more.
    Gone,
}

/// Copy the skill folder `src` — all of it but its SKILL.md, which the caller
/// writes from the text it read — into `dest`, a folder the caller made new
/// and empty for it, within `allowance`.
pub(super) fn copy_tree(src: &Path, dest: &Path, allowance: Allowance) -> io::Result<TreeCopy> {
    let root = match fsb::open_dir(src) {
        Err(e) if gone(&e) => return Ok(TreeCopy::Gone),
        other => other?,
    };
    let mut walk = Walk::new(&root, allowance, fsb::open_at)?;
    match walk.folder(&root, &[], dest, true) {
        Ok(()) => Ok(TreeCopy::Copied { used: allowance.less(walk.left), left_out: walk.left_out }),
        Err(Stop::TooBig) => {
            // Nothing of it stays behind: the folder is as empty as it came.
            fs::remove_dir_all(dest)?;
            fs::create_dir(dest)?;
            Ok(TreeCopy::TooBig)
        }
        Err(Stop::Failed(e)) => Err(e),
    }
}

/// Why a walk stopped short.
enum Stop {
    TooBig,
    /// Writing the copy failed, and not for any one entry's name: the view
    /// itself cannot be made.
    Failed(io::Error),
}

impl From<io::Error> for Stop {
    fn from(e: io::Error) -> Self {
        Stop::Failed(e)
    }
}

/// An entry that is no longer what it was a moment ago — gone, or swapped for
/// a link or a file: a race with whoever edits the skill, passed over.
fn gone(e: &io::Error) -> bool {
    e.kind() == ErrorKind::NotFound || matches!(e.raw_os_error(), Some(libc::ENOTDIR) | Some(libc::ELOOP))
}

/// Where a link leads, opened.
enum Target {
    /// A folder inside the skill, and its path there.
    Folder(File, Vec<OsString>),
    File(File, Stat),
    Special,
}

/// How a walk opens a name inside a folder it holds open, never following it.
type OpenAt = fn(&File, &OsStr, libc::c_int) -> io::Result<File>;

struct Walk<'a> {
    /// The skill's own folder: every read happens beneath it.
    root: &'a File,
    /// Every open the walk makes goes through here — [`fsb::open_at`] — so
    /// its cost is one count: opens, one per name it walks.
    open: OpenAt,
    left: Allowance,
    left_out: Vec<LeftOut>,
    /// The folders being copied, outermost first, by identity: a link to one
    /// of them is a loop. Two links to the same folder side by side are not.
    ancestry: Vec<(u64, u64)>,
}

impl<'a> Walk<'a> {
    fn new(root: &'a File, allowance: Allowance, open: OpenAt) -> io::Result<Self> {
        let top = fsb::stat_of(root)?;
        Ok(Self { root, open, left: allowance, left_out: Vec::new(), ancestry: vec![(top.dev, top.ino)] })
    }

    /// Copy what the open folder `dir` — the skill's own, at `real` inside it —
    /// holds into `dest`.
    fn folder(&mut self, dir: &File, real: &[OsString], dest: &Path, top: bool) -> Result<(), Stop> {
        let names = match fsb::names_in(dir) {
            Ok(names) => names,
            Err(_) => {
                self.leave(real, None, Why::Unreadable);
                return Ok(());
            }
        };
        for name in names {
            // The caller writes the SKILL.md from the text it read; the
            // transient beside it is a save in flight.
            if top && (name == SKILL_FILE || name == "SKILL.md.tmp") {
                continue;
            }
            self.charge()?;
            let stat = match fsb::stat_at(dir, &name) {
                Ok(stat) => stat,
                Err(e) if gone(&e) => continue,
                Err(_) => {
                    self.leave(real, Some(&name), Why::Unreadable);
                    continue;
                }
            };
            let target = dest.join(&name);
            match stat.kind {
                Kind::Dir => match (self.open)(dir, &name, libc::O_DIRECTORY) {
                    Ok(sub) => self.descend(sub, child(real, &name), &target, real, &name)?,
                    Err(e) if gone(&e) => {}
                    Err(_) => self.leave(real, Some(&name), Why::Unreadable),
                },
                Kind::File => match (self.open)(dir, &name, libc::O_NONBLOCK) {
                    Ok(file) => self.file(&file, real, &name, &target)?,
                    Err(e) if gone(&e) => {}
                    Err(_) => self.leave(real, Some(&name), Why::Unreadable),
                },
                Kind::Link => match self.resolve(real, &name) {
                    Ok(Target::Folder(sub, at)) => self.descend(sub, at, &target, real, &name)?,
                    Ok(Target::File(file, stat)) => self.copy(&file, stat, &target, real, &name)?,
                    Ok(Target::Special) => self.leave(real, Some(&name), Why::Special),
                    Err(why) => self.leave(real, Some(&name), why),
                },
                Kind::Other => self.leave(real, Some(&name), Why::Special),
            }
        }
        Ok(())
    }

    /// Copy the open folder `sub` (at `at` inside the skill), reached by the
    /// entry `name` in `real`, into a new `target` — unless it is one of the
    /// folders being copied already.
    fn descend(&mut self, sub: File, at: Vec<OsString>, target: &Path, real: &[OsString], name: &OsStr) -> Result<(), Stop> {
        let stat = fsb::stat_of(&sub)?;
        let id = (stat.dev, stat.ino);
        if self.ancestry.contains(&id) {
            self.leave(real, Some(name), Why::LinkCycle);
            return Ok(());
        }
        if let Err(e) = fs::create_dir(target) {
            return self.unwritten(e, real, name);
        }
        self.ancestry.push(id);
        let walked = self.folder(&sub, &at, target, false);
        self.ancestry.pop();
        walked
    }

    /// Copy the open entry `file`, if it is still a file.
    fn file(&mut self, file: &File, real: &[OsString], name: &OsStr, target: &Path) -> Result<(), Stop> {
        let stat = fsb::stat_of(file)?;
        if stat.kind != Kind::File {
            self.leave(real, Some(name), Why::Special);
            return Ok(());
        }
        self.copy(file, stat, target, real, name)
    }

    fn copy(&mut self, file: &File, stat: Stat, target: &Path, real: &[OsString], name: &OsStr) -> Result<(), Stop> {
        match fsb::copy_file(file, target, fsb::copy_mode(stat.runnable), self.left.bytes) {
            Ok(Some(written)) => {
                self.left.bytes -= written;
                Ok(())
            }
            Ok(None) => Err(Stop::TooBig),
            Err(e) => self.unwritten(e, real, name),
        }
    }

    /// The entry `name` in `real` could not be made in the copy. One the copy
    /// cannot hold under its name is left out, as one broken entry loses only
    /// itself; any other failure is the view's own.
    fn unwritten(&mut self, e: io::Error, real: &[OsString], name: &OsStr) -> Result<(), Stop> {
        let why = match e.raw_os_error() {
            Some(libc::EEXIST) => Why::NameTaken,
            Some(libc::ENAMETOOLONG) => Why::PathTooLong,
            _ => return Err(Stop::Failed(e)),
        };
        self.leave(real, Some(name), why);
        Ok(())
    }

    /// Where the link `name` in the skill's folder `real` leads — followed
    /// from the skill's own folder one name at a time, never out of it, each
    /// folder on the way opened from the one before: one open per name,
    /// however deep the skill.
    fn resolve(&self, real: &[OsString], name: &OsStr) -> Result<Target, Why> {
        // What the names have led to so far, each open: folders, and — as
        // the last name only — whatever else it is.
        let mut way: Vec<(OsString, File)> = Vec::with_capacity(real.len());
        for part in real {
            let dir = (self.open)(here(self.root, &way), part, libc::O_DIRECTORY).map_err(|_| Why::LinkDangles)?;
            way.push((part.clone(), dir));
        }
        let mut pending: VecDeque<OsString> = VecDeque::from([name.to_os_string()]);
        let mut hops = 0;
        while let Some(part) = pending.pop_front() {
            if part == "." {
                continue;
            }
            if part == ".." {
                way.pop().ok_or(Why::LinkOut)?;
                continue;
            }
            let dir = here(self.root, &way);
            let stat = fsb::stat_at(dir, &part).map_err(|e| {
                if e.kind() == ErrorKind::NotFound { Why::LinkDangles } else { Why::Unreadable }
            })?;
            match stat.kind {
                Kind::Link => {
                    hops += 1;
                    if hops > MAX_HOPS {
                        return Err(Why::LinkCycle);
                    }
                    let to = fsb::read_link_at(dir, &part).map_err(|_| Why::Unreadable)?;
                    let mut spliced = Vec::new();
                    for step in Path::new(&to).components() {
                        match step {
                            Component::Normal(step) => spliced.push(step.to_os_string()),
                            Component::ParentDir => spliced.push(OsString::from("..")),
                            Component::CurDir => {}
                            // An absolute target: wherever it points, it is
                            // not a place inside this skill that moves with it.
                            Component::RootDir | Component::Prefix(_) => return Err(Why::LinkOut),
                        }
                    }
                    for step in spliced.into_iter().rev() {
                        pending.push_front(step);
                    }
                }
                // Never opened: nothing to copy, and nothing to wait on — or,
                // named as a folder on the way, nowhere to go on to.
                Kind::Other => {
                    return if pending.is_empty() { Ok(Target::Special) } else { Err(Why::LinkDangles) };
                }
                // A file named as a folder on the way.
                Kind::File if !pending.is_empty() => return Err(Why::LinkDangles),
                Kind::Dir | Kind::File => {
                    let flags = if stat.kind == Kind::Dir { libc::O_DIRECTORY } else { libc::O_NONBLOCK };
                    // Opened following no link: anything swapped in since
                    // refuses rather than leads out.
                    let opened = (self.open)(dir, &part, flags).map_err(|_| Why::LinkDangles)?;
                    way.push((part, opened));
                }
            }
        }
        let Some((last, opened)) = way.pop() else {
            // The skill's own folder.
            return self.root.try_clone().map(|root| Target::Folder(root, Vec::new())).map_err(|_| Why::Unreadable);
        };
        let stat = fsb::stat_of(&opened).map_err(|_| Why::Unreadable)?;
        let mut at: Vec<OsString> = way.into_iter().map(|(part, _)| part).collect();
        at.push(last);
        Ok(match stat.kind {
            Kind::Dir => Target::Folder(opened, at),
            Kind::File => Target::File(opened, stat),
            Kind::Link | Kind::Other => Target::Special,
        })
    }

    /// Take one entry from the allowance.
    fn charge(&mut self) -> Result<(), Stop> {
        if self.left.entries == 0 {
            return Err(Stop::TooBig);
        }
        self.left.entries -= 1;
        Ok(())
    }

    fn leave(&mut self, real: &[OsString], name: Option<&OsStr>, why: Why) {
        let mut path = as_path(real);
        if let Some(name) = name {
            path.push(name);
        }
        self.left_out.push(LeftOut { path, why });
    }
}

/// The folder a link's names have led into: the last one opened on the way,
/// or the skill's own.
fn here<'d>(root: &'d File, way: &'d [(OsString, File)]) -> &'d File {
    way.last().map_or(root, |(_, dir)| dir)
}

fn child(real: &[OsString], name: &OsStr) -> Vec<OsString> {
    let mut at = real.to_vec();
    at.push(name.to_os_string());
    at
}

fn as_path(parts: &[OsString]) -> PathBuf {
    parts.iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    const PLENTY: Allowance = SKILL_MAX;

    /// A skill folder `review` with a SKILL.md, inside a temp dir.
    fn skill() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let skill = tmp.path().join("library").join("review");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join(SKILL_FILE), "---\ndescription: x\n---\n").unwrap();
        (tmp, skill)
    }

    /// Copy `src` into the new folder `dest`, made as the caller makes it.
    fn copy_into(src: &Path, dest: &Path, allowance: Allowance) -> io::Result<TreeCopy> {
        fs::create_dir(dest).unwrap();
        copy_tree(src, dest, allowance)
    }

    fn copied(src: &Path, dest: &Path, allowance: Allowance) -> (Allowance, Vec<LeftOut>) {
        match copy_into(src, dest, allowance).unwrap() {
            TreeCopy::Copied { used, left_out } => (used, left_out),
            other => panic!("not copied: {other:?}"),
        }
    }

    fn left(path: &str, why: Why) -> LeftOut {
        LeftOut { path: PathBuf::from(path), why }
    }

    #[test]
    fn a_tree_is_copied_but_its_skill_file_with_scripts_runnable() {
        let (tmp, skill) = skill();
        fs::create_dir(skill.join("scripts")).unwrap();
        fs::write(skill.join("scripts/run.sh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(skill.join("scripts/run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(skill.join("notes.md"), "notes").unwrap();
        fs::write(skill.join("SKILL.md.tmp"), "torn").unwrap();
        let dest = tmp.path().join("copy");

        let (used, left_out) = copied(&skill, &dest, PLENTY);

        assert!(left_out.is_empty(), "{left_out:?}");
        // scripts/, scripts/run.sh, notes.md — the SKILL.md is the caller's.
        assert_eq!(used, Allowance { entries: 3, bytes: 15 });
        assert!(!dest.join(SKILL_FILE).exists());
        assert!(!dest.join("SKILL.md.tmp").exists());
        assert_eq!(fs::read_to_string(dest.join("notes.md")).unwrap(), "notes");
        let mode = fs::metadata(dest.join("scripts/run.sh")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, fsb::EXEC_FILE_MODE);
    }

    #[test]
    fn a_link_that_leads_out_of_the_skill_is_left_out_and_never_read() {
        let (tmp, skill) = skill();
        let outside = tmp.path().join("secrets");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("key"), "private").unwrap();
        symlink(&outside, skill.join("absolute")).unwrap();
        symlink("../../secrets", skill.join("relative")).unwrap();
        // A prefix that only looks inside: `review-x` is not `review`.
        let sibling = tmp.path().join("library").join("review-x");
        fs::create_dir(&sibling).unwrap();
        symlink("../review-x", skill.join("sibling")).unwrap();
        let dest = tmp.path().join("copy");

        let (_, left_out) = copied(&skill, &dest, PLENTY);

        assert_eq!(
            left_out,
            vec![left("absolute", Why::LinkOut), left("relative", Why::LinkOut), left("sibling", Why::LinkOut)]
        );
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "nothing of the outside was copied");
    }

    #[test]
    fn a_link_inside_the_skill_is_copied_as_what_it_points_to() {
        let (tmp, skill) = skill();
        fs::create_dir_all(skill.join("lib/deep")).unwrap();
        fs::write(skill.join("lib/deep/data.txt"), "data").unwrap();
        symlink("lib/deep/data.txt", skill.join("file-alias")).unwrap();
        symlink("lib/deep", skill.join("dir-alias")).unwrap();
        // Up and back down, still inside.
        symlink("../lib/deep", skill.join("lib/again")).unwrap();
        let dest = tmp.path().join("copy");

        let (_, left_out) = copied(&skill, &dest, PLENTY);

        assert!(left_out.is_empty(), "{left_out:?}");
        for copy in ["file-alias", "dir-alias/data.txt", "lib/again/data.txt", "lib/deep/data.txt"] {
            let path = dest.join(copy);
            assert!(fs::symlink_metadata(&path).unwrap().is_file(), "{copy} is a real file in the copy");
            assert_eq!(fs::read_to_string(&path).unwrap(), "data");
        }
        assert!(fs::symlink_metadata(dest.join("dir-alias")).unwrap().is_dir());
    }

    #[test]
    fn a_dangling_link_is_left_out_and_said() {
        let (tmp, skill) = skill();
        symlink("nowhere", skill.join("dangling")).unwrap();
        symlink("SKILL.md/below", skill.join("through-a-file")).unwrap();
        let dest = tmp.path().join("copy");

        let (_, left_out) = copied(&skill, &dest, PLENTY);

        assert_eq!(left_out, vec![left("dangling", Why::LinkDangles), left("through-a-file", Why::LinkDangles)]);
    }

    #[test]
    fn a_link_back_into_its_own_folders_is_left_out_but_two_aliases_both_copy() {
        let (tmp, skill) = skill();
        fs::create_dir_all(skill.join("lib")).unwrap();
        fs::write(skill.join("lib/x"), "x").unwrap();
        symlink(".", skill.join("lib/self")).unwrap();
        symlink("..", skill.join("lib/up")).unwrap();
        symlink("loop-b", skill.join("loop-a")).unwrap();
        symlink("loop-a", skill.join("loop-b")).unwrap();
        symlink("lib", skill.join("alias-1")).unwrap();
        symlink("lib", skill.join("alias-2")).unwrap();
        let dest = tmp.path().join("copy");

        let (_, left_out) = copied(&skill, &dest, PLENTY);

        // lib/ and each alias of it meet lib's own two back-links, named where
        // they sit; the two links that only point at each other never end.
        let mut cycles: Vec<String> = left_out
            .iter()
            .map(|l| {
                assert_eq!(l.why, Why::LinkCycle, "{l:?}");
                l.path.display().to_string()
            })
            .collect();
        cycles.sort();
        assert_eq!(cycles, ["lib/self", "lib/self", "lib/self", "lib/up", "lib/up", "lib/up", "loop-a", "loop-b"]);
        assert_eq!(fs::read_to_string(dest.join("alias-1/x")).unwrap(), "x");
        assert_eq!(fs::read_to_string(dest.join("alias-2/x")).unwrap(), "x");
    }

    #[test]
    fn a_fifo_and_a_socket_are_left_out_without_waiting() {
        let (tmp, skill) = skill();
        let fifo = std::ffi::CString::new(skill.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a NUL-terminated path alive for the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let _socket = std::os::unix::net::UnixListener::bind(skill.join("sock")).unwrap();
        symlink("pipe", skill.join("to-pipe")).unwrap();
        symlink("sock", skill.join("to-sock")).unwrap();
        let dest = tmp.path().join("copy");

        // A FIFO with no writer would block an ordinary open forever.
        let (done, finished) = std::sync::mpsc::channel();
        let (src, to) = (skill.clone(), dest.clone());
        std::thread::spawn(move || done.send(copied(&src, &to, PLENTY)).unwrap());
        let (_, left_out) = finished.recv_timeout(std::time::Duration::from_secs(5)).expect("the copy hung");

        assert_eq!(
            left_out,
            vec![
                left("pipe", Why::Special),
                left("sock", Why::Special),
                left("to-pipe", Why::Special),
                left("to-sock", Why::Special),
            ]
        );
    }

    thread_local! {
        /// The opens a walk on this test's thread made.
        static OPENS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// [`fsb::open_at`], counted.
    fn counted_open(dir: &File, name: &OsStr, flags: libc::c_int) -> io::Result<File> {
        OPENS.with(|n| n.set(n.get() + 1));
        fsb::open_at(dir, name, flags)
    }

    /// How many opens following the link `name` in the skill's folder `real`
    /// took, and whether it dangled.
    fn opens_to_follow(skill: &Path, real: &[&str], name: &str) -> (usize, bool) {
        let root = fsb::open_dir(skill).unwrap();
        let walk = Walk::new(&root, PLENTY, counted_open).unwrap();
        let real: Vec<OsString> = real.iter().map(OsString::from).collect();
        OPENS.with(|n| n.set(0));
        let dangled = matches!(walk.resolve(&real, OsStr::new(name)), Err(Why::LinkDangles));
        (OPENS.with(std::cell::Cell::get), dangled)
    }

    #[test]
    fn a_link_down_a_deep_skill_costs_one_open_per_name() {
        // Each link leads down a chain of folders to nothing at its bottom.
        // Opened one from the other, the way costs one open per folder on it;
        // reopened from the skill's folder at every name, it cost the square
        // of its depth. Counted, not timed: the count is the property, and a
        // clock measures the machine.
        const DEPTH: usize = 8;
        let (_tmp, skill) = skill();
        let deep: PathBuf = std::iter::repeat_n("d", DEPTH).collect();
        fs::create_dir_all(skill.join(&deep)).unwrap();
        symlink(deep.join("nowhere"), skill.join("down")).unwrap();
        // From the bottom of the chain all the way up, and down it again: the
        // link's own folder is reached one name at a time too, and a `..`
        // costs no open.
        let up: PathBuf = std::iter::repeat_n("..", DEPTH).collect();
        symlink(up.join(&deep).join("nowhere"), skill.join(&deep).join("round")).unwrap();
        let bottom = vec!["d"; DEPTH];

        assert_eq!(opens_to_follow(&skill, &[], "down"), (DEPTH, true));
        assert_eq!(opens_to_follow(&skill, &bottom, "round"), (2 * DEPTH, true));
    }

    #[test]
    fn an_entry_the_copy_cannot_hold_under_its_name_is_left_out_alone() {
        let (tmp, skill) = skill();
        fs::create_dir(skill.join("lib")).unwrap();
        fs::write(skill.join("lib/inner"), "inner").unwrap();
        fs::write(skill.join("notes.md"), "notes").unwrap();
        fs::write(skill.join("other.md"), "other").unwrap();
        // Where the copy is made, a folder and a file hold those two names
        // already — what another entry the volume takes for the same leaves.
        let dest = tmp.path().join("copy");
        fs::create_dir_all(dest.join("lib")).unwrap();
        fs::write(dest.join("notes.md"), "mine").unwrap();

        let TreeCopy::Copied { left_out, .. } = copy_tree(&skill, &dest, PLENTY).unwrap() else {
            panic!("the whole copy failed for two names");
        };

        assert_eq!(left_out, vec![left("lib", Why::NameTaken), left("notes.md", Why::NameTaken)]);
        assert_eq!(fs::read_to_string(dest.join("other.md")).unwrap(), "other");
        assert_eq!(fs::read_to_string(dest.join("notes.md")).unwrap(), "mine", "nothing lands over what is there");
        assert!(!dest.join("lib/inner").exists());
    }

    #[test]
    fn an_entry_whose_path_is_too_long_for_the_copy_is_left_out_alone() {
        let (tmp, skill) = skill();
        fs::create_dir(skill.join("deep")).unwrap();
        fs::write(skill.join("deep/below"), "below").unwrap();
        fs::write(skill.join("near"), "near").unwrap();
        // A copy made so far down that `deep` and `near` still fit in it,
        // and what is inside `deep` no longer does.
        let max = libc::PATH_MAX as usize;
        let want = max - 8 - "/c".len();
        // Measured as the system walks it: macOS's temp folder sits behind
        // a link (`/var` is `/private/var`), whose target counts too.
        let mut parent = fs::canonicalize(tmp.path()).unwrap();
        while want - parent.as_os_str().len() > 202 {
            parent.push("x".repeat(200));
        }
        let pad = want - parent.as_os_str().len() - 1;
        parent.push("y".repeat(pad));
        fs::create_dir_all(&parent).unwrap();
        let dest = parent.join("c");
        assert!(dest.join("deep").as_os_str().len() < max);
        assert!(dest.join("deep/below").as_os_str().len() >= max);

        let (_, left_out) = copied(&skill, &dest, PLENTY);

        assert_eq!(left_out, vec![left("deep/below", Why::PathTooLong)]);
        assert_eq!(fs::read_to_string(dest.join("near")).unwrap(), "near");
    }

    #[test]
    fn a_tree_over_its_allowance_leaves_nothing_behind() {
        let (tmp, skill) = skill();
        fs::create_dir(skill.join("lib")).unwrap();
        fs::write(skill.join("lib/a"), "1234").unwrap();
        fs::write(skill.join("lib/b"), "5678").unwrap();
        let dest = tmp.path().join("copy");
        let exact = Allowance { entries: 3, bytes: 8 };

        assert!(matches!(copy_into(&skill, &dest, exact).unwrap(), TreeCopy::Copied { .. }));
        fs::remove_dir_all(&dest).unwrap();
        for short in [Allowance { entries: 2, bytes: 8 }, Allowance { entries: 3, bytes: 7 }] {
            assert!(matches!(copy_into(&skill, &dest, short).unwrap(), TreeCopy::TooBig), "{short:?}");
            assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "{short:?} left a partial copy");
            fs::remove_dir(&dest).unwrap();
        }
    }

    #[test]
    fn what_is_left_out_costs_the_allowance_too() {
        let (tmp, skill) = skill();
        for n in 0..5 {
            symlink("nowhere", skill.join(format!("dangling-{n}"))).unwrap();
        }
        let dest = tmp.path().join("copy");
        assert!(matches!(copy_into(&skill, &dest, Allowance { entries: 4, bytes: 0 }).unwrap(), TreeCopy::TooBig));
    }

    #[test]
    fn a_folder_that_is_gone_or_a_link_is_no_skill_to_copy() {
        let (tmp, skill) = skill();
        let alias = tmp.path().join("alias");
        symlink(&skill, &alias).unwrap();
        let dest = tmp.path().join("copy");
        assert!(matches!(copy_tree(&alias, &dest, PLENTY).unwrap(), TreeCopy::Gone));
        assert!(matches!(copy_tree(&tmp.path().join("missing"), &dest, PLENTY).unwrap(), TreeCopy::Gone));
    }

    #[test]
    fn a_skill_file_is_read_only_when_it_is_a_small_text_file_of_its_own() {
        let (tmp, skill) = skill();
        assert_eq!(read_skill_file(&skill).unwrap().as_deref(), Some("---\ndescription: x\n---\n"));
        assert_eq!(read_skill_file(&tmp.path().join("missing")).unwrap(), None);

        let empty = tmp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert_eq!(read_skill_file(&empty).unwrap(), None, "a folder without one is no skill");

        let linked = tmp.path().join("linked");
        fs::create_dir(&linked).unwrap();
        symlink(skill.join(SKILL_FILE), linked.join(SKILL_FILE)).unwrap();
        assert!(read_skill_file(&linked).is_err(), "a link in place of SKILL.md");

        let piped = tmp.path().join("piped");
        fs::create_dir(&piped).unwrap();
        let fifo = std::ffi::CString::new(piped.join(SKILL_FILE).as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a NUL-terminated path alive for the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(read_skill_file(&piped).is_err(), "a FIFO is refused, not waited on");

        let huge = tmp.path().join("huge");
        fs::create_dir(&huge).unwrap();
        fs::write(huge.join(SKILL_FILE), vec![b'a'; SKILL_FILE_MAX_BYTES as usize]).unwrap();
        assert!(read_skill_file(&huge).unwrap().is_some(), "exactly the limit is read");
        fs::write(huge.join(SKILL_FILE), vec![b'a'; SKILL_FILE_MAX_BYTES as usize + 1]).unwrap();
        assert!(read_skill_file(&huge).is_err(), "one byte over is refused");

        fs::write(skill.join(SKILL_FILE), [0xff, 0xfe]).unwrap();
        assert!(read_skill_file(&skill).is_err(), "not UTF-8");
    }
}
