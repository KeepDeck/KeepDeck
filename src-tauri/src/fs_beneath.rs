//! Reading a directory tree beneath one open handle on its root: one name at a
//! time, following no link on the way, so what changes under a reader can
//! refuse a step but never lead it out of the tree; a FIFO opened without
//! waiting for a writer. And copying what it reads into files of our own,
//! within a budget.
//!
//! Shared by the two tree copies the host makes: `fsWrite.copyDir`, which
//! refuses a link anywhere in its source, and skills staging, which follows a
//! link only while it stays inside the skill. Both copy under the same limits,
//! so a view staging hands out is one a copy can carry.

use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read as _};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path};

/// How much one tree copy may carry: far above any skill library, low enough
/// that one call cannot fill a disk. Every directory and file under the
/// copied root counts as an entry; only files count bytes.
pub(crate) const COPY_MAX_ENTRIES: usize = 10_000;
pub(crate) const COPY_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Owner-only modes for what a copy CREATES: a directory, a file, and a file
/// its source marked runnable — runnable, by its owner alone.
pub(crate) const DIR_MODE: u32 = 0o700;
pub(crate) const FILE_MODE: u32 = 0o600;
pub(crate) const EXEC_FILE_MODE: u32 = 0o700;

/// The mode a copy of a file is made with: runnable stays runnable.
pub(crate) fn copy_mode(runnable: bool) -> u32 {
    if runnable {
        EXEC_FILE_MODE
    } else {
        FILE_MODE
    }
}

/// What one name in a directory is, read without following it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Dir,
    File,
    Link,
    /// A FIFO, a socket, a device: nothing a copy makes.
    Other,
}

/// One entry's identity and shape.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Stat {
    pub kind: Kind,
    pub dev: u64,
    pub ino: u64,
    pub len: u64,
    pub runnable: bool,
}

/// Open the directory at `path` itself, refusing a link in its place.
pub(crate) fn open_dir(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
}

/// Open the entry at `rel` inside the directory `dir` one name at a time,
/// following no link at any step: a directory replaced by a link refuses the
/// open instead of leading out of the tree. Non-blocking, so a FIFO answers at
/// once (and is then refused as no file) rather than waiting for a writer.
pub(crate) fn open_beneath(dir: &File, rel: &Path) -> io::Result<File> {
    let mut parts = rel.components().peekable();
    let mut at: Option<File> = None;
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(io::Error::new(ErrorKind::InvalidInput, "not a plain relative path"));
        };
        let step = if parts.peek().is_some() { libc::O_DIRECTORY } else { libc::O_NONBLOCK };
        at = Some(open_at(at.as_ref().unwrap_or(dir), name, step)?);
    }
    at.ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "an empty path"))
}

/// Open `name` inside `dir` read-only, never following it.
pub(crate) fn open_at(dir: &File, name: &OsStr, flags: libc::c_int) -> io::Result<File> {
    let name = c_name(name)?;
    // SAFETY: a NUL-terminated name and an open directory, both alive for the
    // call.
    let fd = unsafe {
        libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | flags)
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a descriptor this call just opened, owned by nothing else.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// What `name` inside `dir` is, the name itself and not what it points to.
// stat's field types differ by platform (`st_dev` is i32 on macOS, u64 on
// Linux): each cast is a no-op somewhere.
#[allow(clippy::unnecessary_cast)]
pub(crate) fn stat_at(dir: &File, name: &OsStr) -> io::Result<Stat> {
    let name = c_name(name)?;
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: a NUL-terminated name, an open directory and a buffer the size
    // of a stat, all alive for the call.
    if unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), st.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstatat succeeded, so it filled the buffer.
    let st = unsafe { st.assume_init() };
    let kind = match st.st_mode & libc::S_IFMT {
        libc::S_IFDIR => Kind::Dir,
        libc::S_IFREG => Kind::File,
        libc::S_IFLNK => Kind::Link,
        _ => Kind::Other,
    };
    Ok(Stat {
        kind,
        dev: st.st_dev as u64,
        ino: st.st_ino as u64,
        len: st.st_size as u64,
        runnable: u32::from(st.st_mode) & 0o111 != 0,
    })
}

/// What an open entry is.
pub(crate) fn stat_of(file: &File) -> io::Result<Stat> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = file.metadata()?;
    let kind = if meta.is_dir() {
        Kind::Dir
    } else if meta.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Ok(Stat {
        kind,
        dev: meta.dev(),
        ino: meta.ino(),
        len: meta.len(),
        runnable: meta.permissions().mode() & 0o111 != 0,
    })
}

/// The names in the open directory `dir`, sorted, without `.` and `..`.
pub(crate) fn names_in(dir: &File) -> io::Result<Vec<OsString>> {
    // fdopendir takes its descriptor over: hand it a copy, so `dir` stays ours.
    // SAFETY: an open descriptor, duplicated close-on-exec.
    let fd = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a descriptor of an open directory that nothing else owns.
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let e = io::Error::last_os_error();
        // SAFETY: fdopendir failed, so the descriptor is still ours to close.
        unsafe { libc::close(fd) };
        return Err(e);
    }
    // The copy shares the original's offset: start from the top.
    // SAFETY: a stream fdopendir just opened.
    unsafe { libc::rewinddir(stream) };
    let mut names = Vec::new();
    let failed = loop {
        clear_errno();
        // SAFETY: an open stream; the entry it answers lives until the next
        // readdir on it, and is copied out before that.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let e = io::Error::last_os_error();
            break (e.raw_os_error() != Some(0)).then_some(e);
        }
        // SAFETY: readdir answered an entry whose name is NUL-terminated.
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            names.push(OsString::from_vec(name.to_vec()));
        }
    };
    // SAFETY: the stream, closed once; it closes its descriptor.
    unsafe { libc::closedir(stream) };
    if let Some(e) = failed {
        return Err(e);
    }
    names.sort();
    Ok(names)
}

#[cfg(target_vendor = "apple")]
fn clear_errno() {
    // SAFETY: the calling thread's errno.
    unsafe { *libc::__error() = 0 };
}

#[cfg(target_os = "linux")]
fn clear_errno() {
    // SAFETY: the calling thread's errno.
    unsafe { *libc::__errno_location() = 0 };
}

/// Where the link `name` inside `dir` points, as written.
pub(crate) fn read_link_at(dir: &File, name: &OsStr) -> io::Result<OsString> {
    let name = c_name(name)?;
    let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: a NUL-terminated name, an open directory and a buffer of the
    // length passed, all alive for the call.
    let n = unsafe { libc::readlinkat(dir.as_raw_fd(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    let n = n as usize;
    if n >= buf.len() {
        return Err(io::Error::new(ErrorKind::InvalidData, "a link longer than any path"));
    }
    buf.truncate(n);
    Ok(OsString::from_vec(buf))
}

/// Copy the open regular `file` into a NEW file at `target`, made with
/// `mode`, writing no more than `budget` bytes. `None` when the file holds
/// more than that — whether it said so up front or grew while it was read —
/// and then nothing is left at `target`.
///
/// On macOS a large file is cloned where the volume can (the copy shares the
/// source's blocks until either is written), and every copy keeps the
/// source's extended attributes, as the `fs::copy` skills staging used to
/// make did: whatever the system marked a downloaded file with stays the
/// system's to act on.
pub(crate) fn copy_file(file: &File, target: &Path, mode: u32, budget: u64) -> io::Result<Option<u64>> {
    let len = file.metadata()?.len();
    if len > budget {
        return Ok(None);
    }
    #[cfg(target_vendor = "apple")]
    let cloned = if len >= CLONE_FROM_BYTES { clone_file(file, target, mode)? } else { None };
    #[cfg(not(target_vendor = "apple"))]
    let cloned = None;
    let landed = match cloned {
        Some(landed) => landed,
        None => write_file(file, target, mode, budget)?,
    };
    // What landed is what it costs, cloned or written: a file that grew past
    // the budget since it said its size leaves nothing behind.
    if landed > budget {
        let _ = fs::remove_file(target);
        return Ok(None);
    }
    Ok(Some(landed))
}

/// Write `file` out to the new `target`, never more than one byte past
/// `budget`: how many bytes it holds.
fn write_file(file: &File, target: &Path, mode: u32, budget: u64) -> io::Result<u64> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut copy = OpenOptions::new().write(true).create_new(true).mode(mode).open(target)?;
    // `mode` above passes through the umask; this is the mode meant.
    copy.set_permissions(fs::Permissions::from_mode(mode))?;
    let written = io::copy(&mut file.take(budget.saturating_add(1)), &mut copy)?;
    #[cfg(target_vendor = "apple")]
    keep_xattrs(file, &copy);
    Ok(written)
}

/// From this size on a clone is cheaper than writing the bytes out; below
/// it, a clone's per-file setup costs more than the copy it saves.
#[cfg(target_vendor = "apple")]
const CLONE_FROM_BYTES: u64 = 1024 * 1024;

/// Clone the open `file` to the new `target`: how many bytes the clone
/// holds, or `None` where this volume — or this pair of volumes — cannot
/// clone. The clone carries the data, the extended attributes and the
/// source's mode — reset here to `mode` — but no ACL. It is the file as it
/// was at one instant, so what it holds is what it costs.
#[cfg(target_vendor = "apple")]
fn clone_file(file: &File, target: &Path, mode: u32) -> io::Result<Option<u64>> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = CString::new(target.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: an open descriptor and a NUL-terminated path, both alive for the
    // call.
    if unsafe { libc::fclonefileat(file.as_raw_fd(), libc::AT_FDCWD, path.as_ptr(), 0) } != 0 {
        let e = io::Error::last_os_error();
        return match e.raw_os_error() {
            Some(libc::ENOTSUP) | Some(libc::EXDEV) => Ok(None),
            // EEXIST among them: a copy never lands over anything, nor falls
            // back to writing over it.
            _ => Err(e),
        };
    }
    let made = (|| {
        let copy = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(target)?;
        copy.set_permissions(fs::Permissions::from_mode(mode))?;
        Ok(copy.metadata()?.len())
    })();
    if made.is_err() {
        let _ = fs::remove_file(target);
    }
    made.map(Some)
}

/// The source's extended attributes onto a written copy. Best effort: a
/// volume that keeps none has nothing worth failing the copy for.
#[cfg(target_vendor = "apple")]
fn keep_xattrs(from: &File, to: &File) {
    // SAFETY: two open descriptors; no copyfile state.
    let _ = unsafe { libc::fcopyfile(from.as_raw_fd(), to.as_raw_fd(), std::ptr::null_mut(), libc::COPYFILE_XATTR) };
}

fn c_name(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn a_listing_names_what_is_there_sorted_and_twice_alike() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["b", "a", "c"] {
            fs::write(tmp.path().join(name), "x").unwrap();
        }
        fs::create_dir(tmp.path().join("d")).unwrap();
        let dir = open_dir(tmp.path()).unwrap();
        let expected: Vec<OsString> = ["a", "b", "c", "d"].iter().map(OsString::from).collect();
        assert_eq!(names_in(&dir).unwrap(), expected);
        // The listing reads a copy of the descriptor: a second one starts over.
        assert_eq!(names_in(&dir).unwrap(), expected);
    }

    #[test]
    fn an_entry_is_read_as_itself_never_as_what_it_points_to() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("file"), "four").unwrap();
        fs::create_dir(tmp.path().join("dir")).unwrap();
        symlink("dir", tmp.path().join("link")).unwrap();
        let dir = open_dir(tmp.path()).unwrap();
        let file = stat_at(&dir, OsStr::new("file")).unwrap();
        assert_eq!((file.kind, file.len), (Kind::File, 4));
        assert_eq!(stat_at(&dir, OsStr::new("dir")).unwrap().kind, Kind::Dir);
        assert_eq!(stat_at(&dir, OsStr::new("link")).unwrap().kind, Kind::Link);
        assert_eq!(read_link_at(&dir, OsStr::new("link")).unwrap(), OsString::from("dir"));
        // Opening refuses the link instead of following it.
        assert!(open_beneath(&dir, Path::new("link")).is_err());
        assert!(open_beneath(&dir, Path::new("dir")).is_ok());
    }

    #[test]
    fn a_link_in_place_of_the_root_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("real")).unwrap();
        symlink("real", tmp.path().join("alias")).unwrap();
        assert!(open_dir(&tmp.path().join("real")).is_ok());
        assert!(open_dir(&tmp.path().join("alias")).is_err());
    }

    #[test]
    fn a_copy_is_made_new_with_the_mode_meant_and_within_its_budget() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("src"), "twelve bytes").unwrap();
        let src = File::open(tmp.path().join("src")).unwrap();

        let target = tmp.path().join("copy");
        assert_eq!(copy_file(&src, &target, EXEC_FILE_MODE, 12).unwrap(), Some(12));
        assert_eq!(fs::read_to_string(&target).unwrap(), "twelve bytes");
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, EXEC_FILE_MODE);
        // Never over something that exists.
        assert!(copy_file(&src, &target, FILE_MODE, 12).is_err());

        // One byte short of the file: nothing is made.
        let short = tmp.path().join("short");
        assert_eq!(copy_file(&src, &short, FILE_MODE, 11).unwrap(), None);
        assert!(!short.exists());
    }

    #[test]
    fn a_file_that_holds_more_than_it_said_leaves_nothing_behind() {
        // What a file grown since its size was read looks like: it says
        // nothing, and there is no end to it.
        let endless = File::open("/dev/zero").unwrap();
        assert_eq!(endless.metadata().unwrap().len(), 0);
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("copy");
        assert_eq!(copy_file(&endless, &target, FILE_MODE, 64).unwrap(), None);
        assert!(!target.exists());
    }

    #[cfg(target_vendor = "apple")]
    fn xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
        let (path, name) = (c_name(path.as_os_str()).unwrap(), std::ffi::CString::new(name).unwrap());
        let mut value = vec![0u8; 256];
        // SAFETY: NUL-terminated strings and a buffer of the length passed.
        let n = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
        (n >= 0).then(|| {
            value.truncate(n as usize);
            value
        })
    }

    #[cfg(target_vendor = "apple")]
    fn set_xattr(path: &Path, name: &str, value: &[u8]) {
        let (path, name) = (c_name(path.as_os_str()).unwrap(), std::ffi::CString::new(name).unwrap());
        // SAFETY: NUL-terminated strings and a value of the length passed.
        assert_eq!(unsafe { libc::setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) }, 0);
    }

    #[test]
    #[cfg(target_vendor = "apple")]
    fn a_copy_keeps_the_sources_extended_attributes_and_takes_the_mode_meant_cloned_or_written() {
        // Written (small) and cloned (large) alike: what the source carries
        // comes along, and the source's mode does not.
        let tmp = tempfile::tempdir().unwrap();
        for size in [12, CLONE_FROM_BYTES as usize] {
            let src = tmp.path().join(format!("src-{size}"));
            fs::write(&src, vec![b'x'; size]).unwrap();
            fs::set_permissions(&src, fs::Permissions::from_mode(0o644)).unwrap();
            set_xattr(&src, "user.kd.test", b"kept");

            let target = tmp.path().join(format!("copy-{size}"));
            let copied = copy_file(&File::open(&src).unwrap(), &target, FILE_MODE, u64::MAX).unwrap();

            assert_eq!(copied, Some(size as u64), "{size}");
            assert_eq!(fs::read(&target).unwrap().len(), size);
            assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, FILE_MODE, "{size}");
            assert_eq!(xattr(&target, "user.kd.test").as_deref(), Some(&b"kept"[..]), "{size}");
        }
    }

    #[test]
    #[cfg(target_vendor = "apple")]
    fn a_clone_never_lands_over_what_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::write(&src, vec![b'x'; CLONE_FROM_BYTES as usize]).unwrap();
        let target = tmp.path().join("taken");
        fs::write(&target, "mine").unwrap();
        assert!(copy_file(&File::open(&src).unwrap(), &target, FILE_MODE, u64::MAX).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "mine");
    }
}
