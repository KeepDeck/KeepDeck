//! The `fsWrite` capability's backend ([F8] session-store surgery): narrow
//! write primitives for agent plugins operating on their OWN store paths.
//!
//! Containment differs from the read-side [`crate::containment`]: a write
//! target usually does not exist yet, so it cannot be canonicalized whole.
//! Instead the deepest EXISTING ancestor is canonicalized (defeating symlink
//! escapes) and the not-yet-existing remainder — which must be `..`-free —
//! is re-joined before the `starts_with` proof against the declared roots.
//! A root that cannot be canonicalized falls back to its expanded literal
//! form: the store root may itself be about to be created.
//!
//! Containment is by DECLARED ROOTS, not a denylist — so nothing is
//! special-cased, the artifacts root included: its own threat model
//! treats `data_dir` as agent-writable and answers there.
//!
//! The roots are the PLUGIN'S, looked up here by its id in its grant
//! ([`PluginGrants::write_roots`]: its declared prefixes and the workspace
//! directories it was handed) — never taken from the caller. A copy reads
//! only inside them, except `copyDir`, which may also read the skills views
//! the host staged: what a plugin builds its CLI's layout from.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Component, Path, PathBuf};

use tauri::State;

use crate::containment::expand_home;
use crate::plugin_permissions::PluginGrants;
use crate::skills::SkillsLocks;

#[tauri::command(async)]
pub fn plugins_fs_write_mkdir(grants: State<'_, PluginGrants>, plugin_id: String, path: String) -> Result<(), String> {
    mkdir(path.clone(), roots_of(&grants, &plugin_id, "mkdir", &path)?)
}

#[tauri::command(async)]
pub fn plugins_fs_write_copy(
    grants: State<'_, PluginGrants>,
    plugin_id: String,
    src: String,
    dst: String,
    replace: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    let roots = roots_of(&grants, &plugin_id, "copyFile", &dst)?;
    copy(src, dst, roots, replace)
}

#[tauri::command(async)]
pub fn plugins_fs_write_remove(grants: State<'_, PluginGrants>, plugin_id: String, path: String) -> Result<(), String> {
    remove(path.clone(), roots_of(&grants, &plugin_id, "remove", &path)?)
}

#[tauri::command(async)]
pub fn plugins_fs_write_file(
    grants: State<'_, PluginGrants>,
    plugin_id: String,
    path: String,
    text: String,
) -> Result<(), String> {
    let roots = roots_of(&grants, &plugin_id, "writeFile", &path)?;
    write_file(path, text, roots)
}

#[tauri::command(async)]
pub fn plugins_fs_write_append(
    grants: State<'_, PluginGrants>,
    plugin_id: String,
    path: String,
    line: String,
) -> Result<(), String> {
    let roots = roots_of(&grants, &plugin_id, "appendLine", &path)?;
    append(path, line, roots)
}

#[tauri::command(async)]
pub fn plugins_fs_write_move(
    grants: State<'_, PluginGrants>,
    plugin_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let roots = roots_of(&grants, &plugin_id, "move", &dst)?;
    move_entry(src, dst, roots)
}

#[tauri::command(async)]
pub fn plugins_fs_write_copy_dir(
    grants: State<'_, PluginGrants>,
    locks: State<'_, SkillsLocks>,
    plugin_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let roots = roots_of(&grants, &plugin_id, "copyDir", &dst)?;
    copy_dir(&src, &dst, &roots, &locks)
}

/// Where `plugin_id` may write, or a refusal naming the call.
fn roots_of(grants: &PluginGrants, plugin_id: &str, op: &str, path: &str) -> Result<Vec<String>, String> {
    grants
        .write_roots(plugin_id)
        .map_err(|why| format!("fsWrite.{op}: \"{path}\": {why}"))
}

fn mkdir(path: String, roots: Vec<String>) -> Result<(), String> {
    let target = resolve_write(&path, &roots)?;
    create_dirs_owner_only(&target.path, &target.root)
}

/// Copy one file; with `replace`, the copy is the source's UTF-8 text with
/// each `(from, to)` pair replaced everywhere, in order. A fork moves a
/// session to a new place, and the text of its transcript names the old
/// one: a copy that cannot say where it now lives is half a move.
fn copy(
    src: String,
    dst: String,
    roots: Vec<String>,
    replace: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    let replace = replace.unwrap_or_default();
    if replace.iter().any(|(from, _)| from.is_empty()) {
        return Err("fsWrite.copyFile: a replacement must name something to replace".into());
    }
    // Both ends must be inside the declared prefixes: reading an arbitrary
    // file into the store would smuggle data past the read capability.
    let from = resolve_write(&src, &roots)?;
    let to = resolve_write(&dst, &roots)?;
    // Refuse LOUDLY before opening anything: a copy of a file onto itself
    // truncates the destination first and then "copies" the emptied source —
    // the one-file conversation destroyed. The host cannot know WHY a plugin
    // copies, so it must not silently reinterpret the call either: a plugin
    // that means "no move, same directory" skips the copy on its own side,
    // and a plugin that copies the same path by ACCIDENT deserves the error.
    // Paths are canonicalized by `resolve_write`, so aliases (symlinks,
    // /private vs /var) collapse before the comparison.
    if from.path == to.path {
        return Err(format!(
            "fsWrite.copyFile: source and destination are the same file ({})",
            to.path.display()
        ));
    }
    if let Some(dir) = to.path.parent() {
        create_dirs_owner_only(dir, &to.root)?;
    }
    if replace.is_empty() {
        fs::copy(&from.path, &to.path).map_err(|e| e.to_string())?;
        // The copy inherits the SOURCE's mode, which says nothing about where
        // it is landing.
        restrict_file(&to.path);
        return Ok(());
    }
    let bytes = fs::read(&from.path).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8(bytes).map_err(|_| {
        format!(
            "fsWrite.copyFile: {} is not UTF-8 text, so nothing in it can be replaced",
            from.path.display()
        )
    })?;
    for (from, to) in &replace {
        text = text.replace(from.as_str(), to);
    }
    crate::state::write_atomic_mode(&to.path, text.as_bytes(), Some(FILE_MODE))
        .map_err(|e| e.to_string())
}

/// Remove a file, or a directory with everything under it — what a plugin's
/// own surgery left that nothing needs any more — then every parent left
/// EMPTY by it, up to the declared root: a folder that existed only to hold
/// what is gone is part of what is gone. A symlink is removed as a link,
/// never followed; what is already gone is not an error (a cleanup may run
/// twice); a declared root itself is never removed.
fn remove(path: String, roots: Vec<String>) -> Result<(), String> {
    let dir = resolve_entry(&path, &roots, "remove")?;
    let target = dir.path;
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_dir() => fs::remove_dir_all(&target),
        Ok(_) => fs::remove_file(&target),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => return Err(e.to_string()),
    }
    .map_err(|e| e.to_string())?;
    // `remove_dir` refuses a folder with anything in it, so a parent that
    // something else still uses — another session's files — stays.
    let mut parent = target.parent();
    while let Some(level) = parent {
        if level == dir.root || !level.starts_with(&dir.root) || fs::remove_dir(level).is_err() {
            break;
        }
        parent = level.parent();
    }
    Ok(())
}

fn write_file(
    path: String,
    text: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let target = resolve_write(&path, &roots)?;
    if let Some(dir) = target.path.parent() {
        create_dirs_owner_only(dir, &target.root)?;
    }
    crate::state::write_atomic_mode(&target.path, text.as_bytes(), Some(FILE_MODE))
        .map_err(|e| e.to_string())
}

fn append(
    path: String,
    line: String,
    roots: Vec<String>,
) -> Result<(), String> {
    if line.contains('\n') {
        return Err("appendLine: the line must not contain a newline".into());
    }
    let target = resolve_write(&path, &roots)?;
    if let Some(dir) = target.path.parent() {
        create_dirs_owner_only(dir, &target.root)?;
    }
    let target = target.path;
    let existed = target.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    if !existed {
        restrict_file(&target);
    }
    file.write_all(format!("{line}\n").as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}

/// Move a file or a directory — how a layout built aside is PUBLISHED: the
/// destination is either what it was or what was built, never half of each.
/// An existing destination is SWAPPED with the source in one atomic rename,
/// and the old one, now at the source's path, is removed: a crash at any
/// point leaves the destination whole and any leftover where the plugin built
/// its layout — never a stray copy beside the destination. Both ends are
/// proven by their PARENTS, like `remove`, so a symlink moves as a link and
/// is never resolved to its target. Neither end may be a root itself, and a
/// directory cannot move into itself.
fn move_entry(src: String, dst: String, roots: Vec<String>) -> Result<(), String> {
    let from = resolve_entry(&src, &roots, "move")?;
    let to = resolve_entry(&dst, &roots, "move")?;
    if from.path == to.path {
        return Err(format!("fsWrite.move: source and destination are the same ({})", to.path.display()));
    }
    if to.path.starts_with(&from.path) {
        return Err(format!("fsWrite.move: {} cannot move into itself", from.path.display()));
    }
    fs::symlink_metadata(&from.path).map_err(|e| format!("fsWrite.move: {src}: {e}"))?;
    if let Some(dir) = to.path.parent() {
        create_dirs_owner_only(dir, &to.root)?;
    }
    match fs::symlink_metadata(&to.path) {
        Ok(_) => {
            swap(&from.path, &to.path).map_err(|e| format!("fsWrite.move: {e}"))?;
            let old = match fs::symlink_metadata(&from.path) {
                Ok(meta) if meta.file_type().is_dir() => fs::remove_dir_all(&from.path),
                _ => fs::remove_file(&from.path),
            };
            if let Err(e) = old {
                log::warn!("fsWrite.move: the replaced {} was not removed: {e}", from.path.display());
            }
            Ok(())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => fs::rename(&from.path, &to.path).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Exchange two existing entries in one atomic rename.
#[cfg(target_vendor = "apple")]
fn swap(a: &Path, b: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a = std::ffi::CString::new(a.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    let b = std::ffi::CString::new(b.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    // SAFETY: two NUL-terminated paths that outlive the call.
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Exchange two existing entries in one atomic rename.
#[cfg(target_os = "linux")]
fn swap(a: &Path, b: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a = std::ffi::CString::new(a.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    let b = std::ffi::CString::new(b.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    // SAFETY: two NUL-terminated paths that outlive the call.
    let done = unsafe {
        libc::renameat2(libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), libc::RENAME_EXCHANGE)
    };
    if done == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Where no atomic exchange exists: the destination goes aside under the
/// source's own name once the source has moved out of the way, so a crash
/// still leaves nothing beside the destination.
#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
fn swap(a: &Path, b: &Path) -> std::io::Result<()> {
    let mut held = a.as_os_str().to_os_string();
    held.push(".moving");
    let held = PathBuf::from(held);
    fs::rename(a, &held)?;
    if let Err(e) = fs::rename(b, a) {
        let _ = fs::rename(&held, a);
        return Err(e);
    }
    if let Err(e) = fs::rename(&held, b) {
        let _ = fs::rename(a, b);
        let _ = fs::rename(&held, a);
        return Err(e);
    }
    Ok(())
}

/// How much one `copyDir` may copy: far above any skill library, low enough
/// that one call cannot fill a disk.
const COPY_MAX_ENTRIES: usize = 10_000;
const COPY_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Copy a directory tree to a NEW entry — how a plugin builds its CLI's layout
/// from the skills the host staged, with the files beside each SKILL.md and
/// the scripts still runnable. The destination is proven like `move`'s and
/// must not exist: a copy never merges into or writes over anything. The
/// source is a staged skills view, read while no stage can swap it and no
/// prune remove it, or
/// lies inside the plugin's own roots; nothing else is readable this way.
fn copy_dir(src: &str, dst: &str, roots: &[String], locks: &SkillsLocks) -> Result<(), String> {
    let to = resolve_entry(dst, roots, "copyDir")?;
    let from = realize(&PathBuf::from(expand_home(src)?)).map_err(|e| format!("fsWrite.copyDir: {src}: {e}"))?;
    if to.path.starts_with(&from) {
        return Err(format!("fsWrite.copyDir: {} cannot be copied into itself", from.display()));
    }
    if fs::symlink_metadata(&to.path).is_ok() {
        return Err(format!("fsWrite.copyDir: {} already exists", to.path.display()));
    }
    let copy = || copy_tree(&from, &to);
    if let Some(copied) = crate::skills::reading_staged_view(locks, &from, copy) {
        return copied;
    }
    if resolve_write(src, roots).is_err() {
        return Err(format!("fsWrite.copyDir: {src} is outside what this plugin may copy from"));
    }
    copy()
}

/// The whole tree is surveyed before anything is written, so a source that
/// holds a link, something that is neither a file nor a directory, or more
/// than a copy may carry is refused with nothing written.
fn copy_tree(from: &Path, to: &WriteTarget) -> Result<(), String> {
    let entries = survey(from)?;
    make(from, to, &entries)
}

/// Make the copy `survey` planned. The source is read beneath one handle on
/// its root, so what changed since the survey can refuse the copy but never
/// widen it: no link is followed on the way to a file, a FIFO is not waited
/// on, and no more is written than a copy may carry. What it makes is
/// owner-only, and a runnable file stays runnable by its owner. A copy that
/// fails halfway removes the tree it was making.
fn make(from: &Path, to: &WriteTarget, entries: &[CopiedEntry]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(from)
        .map_err(|e| format!("fsWrite.copyDir: {}: {e}", from.display()))?;
    if let Some(dir) = to.path.parent() {
        create_dirs_owner_only(dir, &to.root)?;
    }
    fs::create_dir(&to.path).map_err(|e| format!("fsWrite.copyDir: {}: {e}", to.path.display()))?;
    restrict_dir(&to.path);
    let mut budget = COPY_MAX_BYTES;
    let made = entries.iter().try_for_each(|entry| entry.place(&source, from, &to.path, &mut budget));
    if made.is_err() {
        let _ = fs::remove_dir_all(&to.path);
    }
    made.map_err(|e| format!("fsWrite.copyDir: {e}"))
}

/// One entry of a copy, by its path inside the tree.
struct CopiedEntry {
    rel: PathBuf,
    /// `None` for a directory, else the mode its copy is made with.
    file_mode: Option<u32>,
}

impl CopiedEntry {
    /// Make this entry's copy under `to`, reading it beneath `source` (the
    /// tree's root, at `from`) and taking what it writes from `budget`.
    fn place(&self, source: &fs::File, from: &Path, to: &Path, budget: &mut u64) -> Result<(), String> {
        use std::io::Read as _;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let target = to.join(&self.rel);
        let Some(mode) = self.file_mode else {
            return fs::create_dir(&target)
                .map(|()| restrict_dir(&target))
                .map_err(|e| format!("{}: {e}", target.display()));
        };
        let named = from.join(&self.rel);
        let fail = |e: io::Error| format!("{}: {e}", named.display());
        let mut file = open_beneath(source, &self.rel).map_err(fail)?;
        let meta = file.metadata().map_err(fail)?;
        if !meta.is_file() {
            return Err(format!("{} is no longer a file", named.display()));
        }
        if meta.len() > *budget {
            return Err(format!("{} grew past what a copy may carry", named.display()));
        }
        let mut copy = OpenOptions::new().write(true).create_new(true).mode(mode).open(&target).map_err(fail)?;
        // `mode` above passes through the umask; this is the mode meant.
        copy.set_permissions(fs::Permissions::from_mode(mode)).map_err(fail)?;
        let written = io::copy(&mut (&mut file).take(*budget + 1), &mut copy).map_err(fail)?;
        if written > *budget {
            return Err(format!("{} grew past what a copy may carry", named.display()));
        }
        *budget -= written;
        Ok(())
    }
}

/// Open the file at `rel` inside the directory `dir` one name at a time,
/// following no link at any step: a directory replaced by a link refuses the
/// open instead of leading out of the tree. Non-blocking, so a FIFO answers at
/// once (and is then refused as no file) rather than waiting for a writer.
fn open_beneath(dir: &fs::File, rel: &Path) -> io::Result<fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let mut parts = rel.components().peekable();
    let mut at: Option<fs::File> = None;
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(io::Error::new(ErrorKind::InvalidInput, "not a plain relative path"));
        };
        let name = CString::new(name.as_bytes()).map_err(io::Error::other)?;
        let step = if parts.peek().is_some() { libc::O_DIRECTORY } else { libc::O_NONBLOCK };
        let base = at.as_ref().unwrap_or(dir).as_raw_fd();
        // SAFETY: a NUL-terminated name and an open directory, both alive for
        // the call.
        let fd = unsafe { libc::openat(base, name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | step) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a descriptor this call just opened, owned by nothing else.
        at = Some(unsafe { fs::File::from_raw_fd(fd) });
    }
    at.ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "an empty path"))
}

/// Every entry under `from`, each directory before what it holds.
fn survey(from: &Path) -> Result<Vec<CopiedEntry>, String> {
    use std::os::unix::fs::PermissionsExt;
    let refuse = |path: &Path, why: &str| format!("fsWrite.copyDir: {} {why} — nothing was copied", path.display());
    let root = fs::symlink_metadata(from).map_err(|e| format!("fsWrite.copyDir: {}: {e}", from.display()))?;
    if !root.is_dir() {
        return Err(refuse(from, "is not a directory"));
    }
    let (mut entries, mut bytes) = (Vec::new(), 0u64);
    let mut pending = vec![PathBuf::new()];
    while let Some(dir) = pending.pop() {
        let listing = fs::read_dir(from.join(&dir)).map_err(|e| format!("fsWrite.copyDir: {}: {e}", from.join(&dir).display()))?;
        for entry in listing {
            let entry = entry.map_err(|e| format!("fsWrite.copyDir: {e}"))?;
            let rel = dir.join(entry.file_name());
            // A directory entry's metadata does not follow a link.
            let meta = entry.metadata().map_err(|e| format!("fsWrite.copyDir: {}: {e}", entry.path().display()))?;
            let file_mode = if meta.is_dir() {
                pending.push(rel.clone());
                None
            } else if meta.is_file() {
                bytes += meta.len();
                Some(if meta.permissions().mode() & 0o111 != 0 { EXEC_FILE_MODE } else { FILE_MODE })
            } else if meta.file_type().is_symlink() {
                return Err(refuse(&entry.path(), "is a symbolic link"));
            } else {
                return Err(refuse(&entry.path(), "is neither a file nor a directory"));
            };
            entries.push(CopiedEntry { rel, file_mode });
            if entries.len() > COPY_MAX_ENTRIES || bytes > COPY_MAX_BYTES {
                return Err(refuse(
                    from,
                    &format!("holds more than a copy may carry ({COPY_MAX_ENTRIES} entries, {COPY_MAX_BYTES} bytes)"),
                ));
            }
        }
    }
    Ok(entries)
}

/// An entry proven by its parent, the name re-joined: realizing the entry
/// itself would resolve a symlink to its target. A root is no entry.
fn resolve_entry(path: &str, roots: &[String], op: &str) -> Result<WriteTarget, String> {
    let literal = PathBuf::from(expand_home(path)?);
    let (Some(parent), Some(name)) = (literal.parent(), literal.file_name()) else {
        return Err(format!("fsWrite.{op}: {path} names no file"));
    };
    let dir = resolve_write(&parent.to_string_lossy(), roots)?;
    let entry = dir.path.join(name);
    if entry == dir.root || !entry.starts_with(&dir.root) {
        return Err(format!("fsWrite.{op}: {path} is a declared root, not inside one"));
    }
    Ok(WriteTarget { path: entry, root: dir.root })
}

/// Owner-only modes for what this capability CREATES.
///
/// The bridge inbox already restricts itself for the same reason
/// (`bridge.rs`), but it lives inside the home, whose own mode is a
/// backstop. A declared write root can leave the home entirely — opencode's
/// fork writes a whole conversation export under `/tmp` — and there nothing
/// else narrows it: `create_dir_all` yields 0755 and a fresh file 0644, so
/// the export was readable by every local user until the OS reaped it.
const DIR_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;
/// A copied file its source marked runnable: runnable, by its owner alone.
const EXEC_FILE_MODE: u32 = 0o700;

/// Create `dir` and its missing ancestors, restricting ONLY what this call
/// creates AT OR BELOW the declared root.
///
/// Two rules, each with a reason:
/// - A directory that already existed belongs to the user or the agent — an
///   agent store like `~/.claude/projects` is theirs to share. Ownership is
///   proven by `create_dir` SUCCEEDING, not by an exists() probe: the probe
///   left a window where a directory another process created in between was
///   narrowed as if it were ours.
/// - Ancestors ABOVE the root are outside the capability's scope entirely
///   (a shared `/tmp/foo` above a declared `/tmp/foo/bar`): create them if
///   missing, never touch their modes.
fn create_dirs_owner_only(dir: &Path, root: &Path) -> Result<(), String> {
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut levels = Vec::new();
    let mut cursor = Some(dir);
    while let Some(path) = cursor {
        if !path.starts_with(root) {
            break;
        }
        levels.push(path.to_path_buf());
        if path == root {
            break;
        }
        cursor = path.parent();
    }
    for level in levels.iter().rev() {
        match fs::create_dir(level) {
            Ok(()) => restrict_dir(level),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Best-effort, like the bridge's: a plugin's write must not fail because a
/// mode could not be set, but nothing it creates starts out world-readable.
fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(DIR_MODE));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Canonicalize the deepest existing ancestor and re-join the (`..`-free)
/// remainder — the write-side symlink-escape proof.
fn realize(path: &Path) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("path must not contain ..".into());
    }
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    crate::containment::real_prefix(path)
}

/// A containment-proven write target together with the declared root that
/// admitted it — the boundary `create_dirs_owner_only` restricts within.
struct WriteTarget {
    path: PathBuf,
    root: PathBuf,
}

fn resolve_write(path: &str, roots: &[String]) -> Result<WriteTarget, String> {
    let real = realize(&PathBuf::from(expand_home(path)?))?;
    for root in roots {
        let expanded = PathBuf::from(expand_home(root)?);
        let root_real = fs::canonicalize(&expanded).unwrap_or(expanded);
        // A root whose canonical form is "/" or the whole home authorizes
        // nothing. The manifest guard already refuses the literal spellings;
        // this is the proof's own half, for the spellings ("~/../..") a
        // string denylist cannot enumerate.
        if crate::containment::is_unbounded_root(&root_real) {
            continue;
        }
        if real.starts_with(&root_real) {
            return Ok(WriteTarget {
                path: real,
                root: root_real,
            });
        }
    }
    Err(format!("path is outside the declared write prefixes: {path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![dir.path().to_string_lossy().into_owned()];
        (dir, roots)
    }

    #[test]
    fn writes_are_contained_to_the_declared_roots() {
        let (dir, roots) = root();
        let inside = dir.path().join("a/b/file.txt");
        write_file(
            inside.to_string_lossy().into_owned(),
            "hi".into(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&inside).unwrap(), "hi");

        let err = write_file("/tmp/elsewhere.txt".into(), "x".into(), roots)
            .unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn what_the_capability_creates_is_owner_only() {
        let (dir, roots) = root();
        // A declared root can sit outside the home (opencode's fork writes a
        // whole conversation export under /tmp), so the default 0755/0644
        // would leave it readable by every local user.
        let scratch = dir.path().join("scratch");
        let file = scratch.join("export.json");
        write_file(
            file.to_string_lossy().into_owned(),
            "transcript".into(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(mode_of(&scratch), DIR_MODE);
        assert_eq!(mode_of(&file), FILE_MODE);

        let appended = scratch.join("log.txt");
        append(
            appended.to_string_lossy().into_owned(),
            "line".into(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(mode_of(&appended), FILE_MODE);

        let copied = scratch.join("copy.json");
        copy(
            file.to_string_lossy().into_owned(),
            copied.to_string_lossy().into_owned(),
            roots,
            None,
        )
        .unwrap();
        assert_eq!(mode_of(&copied), FILE_MODE);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_refused_not_followed() {
        let (dir, roots) = root();
        // A dangling link canonicalizes to NotFound, exactly like a missing
        // file — but it EXISTS, and creating "through" it follows the link
        // out of the root: append used to land in the link's target.
        let outside = dir.path().join("outside-marker");
        let link = dir.path().join("notes.log");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let err = append(
            link.to_string_lossy().into_owned(),
            "stolen line".into(),
            roots.clone(),
        )
        .unwrap_err();
        assert!(err.contains("broken symlink"), "{err}");
        assert!(!outside.exists(), "the write followed the link");

        let err = write_file(
            link.to_string_lossy().into_owned(),
            "content".into(),
            roots,
        )
        .unwrap_err();
        assert!(err.contains("broken symlink"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn ancestors_above_the_declared_root_are_never_restricted() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        // Canonical base: a NOT-yet-existing root keeps its literal spelling
        // (documented fallback), so under macOS's symlinked /var tempdir the
        // literal would never match the canonicalized target.
        let base = fs::canonicalize(temp.path()).unwrap();
        // The declared root sits two levels down; the level between —
        // outside the capability's scope — is created by someone else at a
        // shared mode.
        let shared = base.join("shared");
        fs::create_dir_all(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).unwrap();
        let declared = shared.join("kd-exports");
        let roots = vec![declared.to_string_lossy().into_owned()];

        write_file(
            declared.join("deep/a.json").to_string_lossy().into_owned(),
            "x".into(),
            roots,
        )
        .unwrap();

        // Inside the declaration: ours, restricted.
        assert_eq!(mode_of(&declared), DIR_MODE);
        assert_eq!(mode_of(&declared.join("deep")), DIR_MODE);
        // Outside it: not ours to narrow, whoever creates or owns it.
        assert_eq!(mode_of(&shared), 0o755);

        // The sharper half: the above-root ancestor MISSING. It must come
        // out at whatever mode the platform gives a fresh directory — the
        // probe dir reads that answer — never our 0700. (When the umask
        // itself yields 0700 the two are indistinguishable; the probe guard
        // keeps the assert honest instead of flaky.)
        let probe = base.join("umask-probe");
        fs::create_dir(&probe).unwrap();
        let platform_mode = mode_of(&probe);
        let above = base.join("shared-missing");
        let declared = above.join("kd-exports");
        write_file(
            declared.join("b.json").to_string_lossy().into_owned(),
            "x".into(),
            vec![declared.to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(mode_of(&declared), DIR_MODE);
        if platform_mode != DIR_MODE {
            assert_eq!(mode_of(&above), platform_mode);
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_directory_keeps_the_mode_its_owner_chose() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, roots) = root();
        // An agent store the user shares on purpose — writing a file into it
        // must not silently narrow it.
        let store = dir.path().join("store");
        fs::create_dir_all(&store).unwrap();
        fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();

        write_file(
            store.join("session.json").to_string_lossy().into_owned(),
            "{}".into(),
            roots,
        )
        .unwrap();

        assert_eq!(mode_of(&store), 0o755);
        assert_eq!(mode_of(&store.join("session.json")), FILE_MODE);
    }

    #[test]
    fn an_unbounded_root_authorizes_nothing() {
        // These roots never pass the manifest's parse guard — but this layer
        // must hold on its own: "~/../.." is not literally "/" and slips any
        // spelling denylist, yet canonicalizes to exactly the root the guard
        // exists to refuse.
        let home = std::env::var("HOME").unwrap();
        // A prior run (or a deliberately-broken build under RED-check) may
        // have left the probe behind — the final assert must judge THIS run.
        let _ = fs::remove_file("/tmp/kd-unbounded-root-probe.txt");
        for root in ["/".to_string(), home.clone(), format!("{home}/../..")] {
            let err = write_file(
                "/tmp/kd-unbounded-root-probe.txt".into(),
                "x".into(),
                vec![root.clone()],
            )
            .unwrap_err();
            assert!(err.contains("outside"), "root {root:?} authorized: {err}");
        }
        assert!(!Path::new("/tmp/kd-unbounded-root-probe.txt").exists());
    }

    #[test]
    fn parent_dir_components_are_rejected() {
        let (dir, roots) = root();
        let sneaky = format!("{}/a/../../etc/x", dir.path().to_string_lossy());
        assert!(write_file(sneaky, "x".into(), roots).is_err());
    }

    #[test]
    fn a_symlink_escaping_the_root_is_refused() {
        let (dir, roots) = root();
        let outside = tempfile::tempdir().unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let through = link.join("file.txt");
        let err = write_file(
            through.to_string_lossy().into_owned(),
            "x".into(),
            roots,
        )
        .unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn copy_requires_both_ends_inside() {
        let (dir, roots) = root();
        let src = dir.path().join("src.txt");
        fs::write(&src, "data").unwrap();
        let dst = dir.path().join("sub/dst.txt");
        copy(
            src.to_string_lossy().into_owned(),
            dst.to_string_lossy().into_owned(),
            roots.clone(),
            None,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "data");

        // Reading from outside the prefixes must refuse, even to a valid dst.
        let foreign = tempfile::tempdir().unwrap();
        let outside_src = foreign.path().join("secret.txt");
        fs::write(&outside_src, "secret").unwrap();
        assert!(copy(
            outside_src.to_string_lossy().into_owned(),
            dir.path().join("stolen.txt").to_string_lossy().into_owned(),
            roots,
            None,
        )
        .is_err());
    }

    #[test]
    fn copy_onto_itself_is_refused_and_leaves_the_file_intact() {
        // fs::copy opens the destination with O_TRUNC before reading the
        // source, so a same-file copy "succeeds" by destroying the file —
        // a one-transcript conversation annihilated. The refusal must fire
        // BEFORE any open, and the original must survive byte for byte.
        let (dir, roots) = root();
        let file = dir.path().join("s.jsonl");
        fs::write(&file, "line1\nline2\n").unwrap();
        let p = file.to_string_lossy().into_owned();
        let err = copy(p.clone(), p, roots, None).unwrap_err();
        assert!(err.contains("same file"), "{err}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "line1\nline2\n");
    }

    #[test]
    fn append_accumulates_and_rejects_newlines() {
        let (dir, roots) = root();
        let file = dir.path().join("index.jsonl");
        let p = file.to_string_lossy().into_owned();
        append(p.clone(), "{\"a\":1}".into(), roots.clone()).unwrap();
        append(p.clone(), "{\"b\":2}".into(), roots.clone()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
        assert!(append(p, "a\nb".into(), roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn copy_with_replace_rewrites_every_occurrence_in_order() {
        let (dir, roots) = root();
        let src = dir.path().join("s.jsonl");
        fs::write(&src, "{\"p\":\"/a/S/x\"}\n{\"q\":\"/a/S/y /a/S/z\"}\n").unwrap();
        let dst = dir.path().join("t/F.jsonl");
        copy(
            src.to_string_lossy().into_owned(),
            dst.to_string_lossy().into_owned(),
            roots,
            Some(vec![("/a/S/".into(), "/b/F/".into()), ("/b/F/z".into(), "/b/F/zz".into())]),
        )
        .unwrap();
        // Every occurrence, and pairs in order: the second sees the first's output.
        assert_eq!(
            fs::read_to_string(&dst).unwrap(),
            "{\"p\":\"/b/F/x\"}\n{\"q\":\"/b/F/y /b/F/zz\"}\n"
        );
        // The source is never touched.
        assert!(fs::read_to_string(&src).unwrap().contains("/a/S/x"));
        assert_eq!(mode_of(&dst), FILE_MODE);
    }

    #[test]
    fn copy_with_replace_refuses_what_it_cannot_rewrite() {
        let (dir, roots) = root();
        let src = dir.path().join("bin");
        fs::write(&src, [0xff, 0xfe, 0x00]).unwrap();
        let dst = dir.path().join("out");
        let ask = |pairs: Vec<(String, String)>| {
            copy(
                src.to_string_lossy().into_owned(),
                dst.to_string_lossy().into_owned(),
                roots.clone(),
                Some(pairs),
            )
        };
        let err = ask(vec![("a".into(), "b".into())]).unwrap_err();
        assert!(err.contains("not UTF-8"), "{err}");
        let err = ask(vec![(String::new(), "b".into())]).unwrap_err();
        assert!(err.contains("name something"), "{err}");
        assert!(!dst.exists());
    }

    #[test]
    fn remove_takes_a_file_or_a_whole_directory_and_is_idempotent() {
        let (dir, roots) = root();
        let file = dir.path().join("p/S.jsonl");
        let tree = dir.path().join("p/F");
        fs::create_dir_all(tree.join("subagents")).unwrap();
        fs::write(&file, "x").unwrap();
        fs::write(tree.join("subagents/agent-1.jsonl"), "y").unwrap();
        for target in [&file, &tree] {
            let p = target.to_string_lossy().into_owned();
            remove(p.clone(), roots.clone()).unwrap();
            assert!(fs::symlink_metadata(target).is_err());
            // Already gone is not an error: a cleanup may run twice.
            remove(p, roots.clone()).unwrap();
        }
        // Emptied by the last removal, `p` went with it; the root stays.
        assert!(!dir.path().join("p").exists());
        assert!(dir.path().is_dir());
    }

    #[test]
    fn remove_prunes_only_parents_it_left_empty() {
        let (dir, roots) = root();
        let kept = dir.path().join("projects/-shared/other-session.jsonl");
        let gone = dir.path().join("projects/-shared/F/subagents/a.jsonl");
        let lone = dir.path().join("projects/-new/T.jsonl");
        for file in [&kept, &gone, &lone] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "x").unwrap();
        }
        remove(
            dir.path().join("projects/-shared/F").to_string_lossy().into_owned(),
            roots.clone(),
        )
        .unwrap();
        remove(lone.to_string_lossy().into_owned(), roots).unwrap();
        // A folder something else still uses stays; one that held only what
        // went goes too — but never past the declared root.
        assert!(kept.exists());
        assert!(!dir.path().join("projects/-new").exists());
        assert!(dir.path().join("projects").is_dir());
    }

    #[test]
    fn remove_never_takes_a_root_or_anything_outside() {
        let (dir, roots) = root();
        let err = remove(dir.path().to_string_lossy().into_owned(), roots.clone())
            .unwrap_err();
        assert!(err.contains("outside") || err.contains("root"), "{err}");
        assert!(dir.path().is_dir());
        let foreign = tempfile::tempdir().unwrap();
        let victim = foreign.path().join("keep.txt");
        fs::write(&victim, "keep").unwrap();
        assert!(remove(victim.to_string_lossy().into_owned(), roots).is_err());
        assert!(victim.exists());
    }

    #[cfg(unix)]
    #[test]
    fn remove_takes_a_symlink_as_a_link_and_leaves_its_target() {
        let (dir, roots) = root();
        let foreign = tempfile::tempdir().unwrap();
        let target = foreign.path().join("data");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "keep").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        remove(link.to_string_lossy().into_owned(), roots).unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn move_publishes_a_built_directory_in_place_of_the_old_one() {
        let (dir, roots) = root();
        let built = dir.path().join("plugin.tmp");
        let live = dir.path().join("plugin");
        fs::create_dir_all(built.join("skills/a")).unwrap();
        fs::write(built.join("skills/a/SKILL.md"), "new").unwrap();
        fs::create_dir_all(live.join("skills/gone")).unwrap();
        fs::write(live.join("skills/gone/SKILL.md"), "old").unwrap();
        move_entry(s(&built), s(&live), roots).unwrap();
        assert_eq!(fs::read_to_string(live.join("skills/a/SKILL.md")).unwrap(), "new");
        assert!(!live.join("skills/gone").exists(), "nothing of the old layout survives");
        assert!(!built.exists());
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("plugin")], "no aside copy is left");
    }

    #[test]
    fn move_swaps_a_file_over_a_file_and_takes_the_old_one_from_the_source() {
        let (dir, roots) = root();
        let (src, dst) = (dir.path().join("new.json"), dir.path().join("live.json"));
        fs::write(&src, "new").unwrap();
        fs::write(&dst, "old").unwrap();
        swap(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
        assert_eq!(fs::read_to_string(&src).unwrap(), "old", "a crash here leaves the old one at the source");
        swap(&src, &dst).unwrap();
        move_entry(s(&src), s(&dst), roots).unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
        assert!(!src.exists());
    }

    #[test]
    fn move_creates_missing_parents_and_moves_a_file() {
        let (dir, roots) = root();
        let src = dir.path().join("a.txt");
        fs::write(&src, "x").unwrap();
        let dst = dir.path().join("deep/er/b.txt");
        move_entry(s(&src), s(&dst), roots).unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "x");
        assert!(!src.exists());
    }

    #[test]
    fn move_refuses_either_end_outside_a_root_and_a_root_itself() {
        let (dir, roots) = root();
        let outside = tempfile::tempdir().unwrap();
        let inside = dir.path().join("in.txt");
        fs::write(&inside, "x").unwrap();
        let foreign = outside.path().join("out.txt");
        fs::write(&foreign, "y").unwrap();
        assert!(move_entry(s(&foreign), s(&dir.path().join("got")), roots.clone()).is_err());
        assert!(move_entry(s(&inside), s(&outside.path().join("leak")), roots.clone()).is_err());
        assert!(move_entry(s(&inside), s(dir.path()), roots.clone()).is_err());
        assert!(move_entry(s(dir.path()), s(&outside.path().join("all")), roots).is_err());
        assert!(inside.exists() && foreign.exists(), "a refused move moves nothing");
    }

    #[test]
    fn move_refuses_a_missing_source_itself_and_into_itself() {
        let (dir, roots) = root();
        let src = dir.path().join("d");
        assert!(move_entry(s(&src), s(&dir.path().join("e")), roots.clone()).is_err());
        fs::create_dir(&src).unwrap();
        assert!(move_entry(s(&src), s(&src), roots.clone()).is_err());
        assert!(move_entry(s(&src), s(&src.join("inner")), roots).is_err());
        assert!(src.is_dir());
    }

    #[test]
    fn move_takes_a_symlink_as_a_link() {
        let (dir, roots) = root();
        let foreign = tempfile::tempdir().unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(foreign.path(), &link).unwrap();
        let moved = dir.path().join("moved");
        move_entry(s(&link), s(&moved), roots).unwrap();
        assert!(fs::symlink_metadata(&moved).unwrap().file_type().is_symlink());
        assert!(foreign.path().is_dir(), "the target stays where it was");
    }

    /// A skill as a library holds one: its SKILL.md, a reference beside it, a
    /// script anyone may run and a file that is not text.
    fn skill_tree(at: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(at.join("references")).unwrap();
        fs::create_dir_all(at.join("scripts")).unwrap();
        fs::write(at.join("SKILL.md"), "---\ndescription: Reviews\n---\n").unwrap();
        fs::write(at.join("references/design-patterns.md"), "patterns").unwrap();
        fs::write(at.join("scripts/run.sh"), "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(at.join("scripts/run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(at.join("logo.png"), [0x89, b'P', 0x00, 0xff]).unwrap();
    }

    #[test]
    fn copy_dir_copies_a_tree_whole_owner_only_with_its_scripts_runnable() {
        let (dir, roots) = root();
        let src = dir.path().join("built/review");
        skill_tree(&src);
        let dst = dir.path().join("layout/skills/review");
        copy_dir(&s(&src), &s(&dst), &roots, &SkillsLocks::default()).unwrap();
        assert_eq!(fs::read_to_string(dst.join("references/design-patterns.md")).unwrap(), "patterns");
        assert_eq!(fs::read(dst.join("logo.png")).unwrap(), [0x89, b'P', 0x00, 0xff]);
        assert_eq!(mode_of(&dst.join("scripts/run.sh")), EXEC_FILE_MODE);
        assert_eq!(mode_of(&dst.join("SKILL.md")), FILE_MODE);
        for made in [dir.path().join("layout"), dst.clone(), dst.join("references"), dst.join("scripts")] {
            assert_eq!(mode_of(&made), DIR_MODE, "{}", made.display());
        }
    }

    #[test]
    fn copy_dir_reads_a_staged_skills_view_and_nothing_else_outside_the_plugins_roots() {
        let (dir, roots) = root();
        let staging = crate::paths::keepdeck_home().unwrap().join("skills/staging");
        let view = staging.join("ws-1/skills");
        skill_tree(&view.join("review"));
        let locks = SkillsLocks::default();
        copy_dir(&s(&view), &s(&dir.path().join("plugin/skills")), &roots, &locks).unwrap();
        assert!(dir.path().join("plugin/skills/review/references/design-patterns.md").is_file());

        // A build-aside, the folder around a view, and any other place are
        // not views.
        skill_tree(&staging.join(".tmp-ws-1/skills/review"));
        let foreign = tempfile::tempdir().unwrap();
        skill_tree(foreign.path());
        for source in [staging.join(".tmp-ws-1/skills"), staging.join("ws-1"), foreign.path().to_path_buf()] {
            let dst = dir.path().join("stolen");
            let err = copy_dir(&s(&source), &s(&dst), &roots, &locks).unwrap_err();
            assert!(err.contains("outside what this plugin may copy from"), "{err}");
            assert!(!dst.exists());
        }
    }

    #[test]
    fn copy_dir_refuses_a_link_anywhere_in_the_source_and_writes_nothing() {
        let (dir, roots) = root();
        let src = dir.path().join("src");
        skill_tree(&src);
        let foreign = tempfile::tempdir().unwrap();
        fs::write(foreign.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(foreign.path().join("secret"), src.join("references/leak.md")).unwrap();
        let dst = dir.path().join("dst");
        let err = copy_dir(&s(&src), &s(&dst), &roots, &SkillsLocks::default()).unwrap_err();
        assert!(err.contains("leak.md is a symbolic link — nothing was copied"), "{err}");
        assert!(!dst.exists(), "nothing was written");
    }

    #[test]
    fn copy_dir_writes_into_nothing_that_exists_nor_into_itself() {
        let (dir, roots) = root();
        let src = dir.path().join("src");
        skill_tree(&src);
        let taken = dir.path().join("taken");
        fs::create_dir(&taken).unwrap();
        fs::write(taken.join("mine.txt"), "mine").unwrap();
        let locks = SkillsLocks::default();
        let err = copy_dir(&s(&src), &s(&taken), &roots, &locks).unwrap_err();
        assert!(err.contains("exists"), "{err}");
        assert_eq!(fs::read_dir(&taken).unwrap().count(), 1, "the existing directory is left as it was");
        let err = copy_dir(&s(&src), &s(&src.join("copy")), &roots, &locks).unwrap_err();
        assert!(err.contains("into itself"), "{err}");
        let err = copy_dir(&s(&src.join("SKILL.md")), &s(&dir.path().join("file")), &roots, &locks).unwrap_err();
        assert!(err.contains("not a directory"), "{err}");
        let err = copy_dir(&s(&src), &s(dir.path()), &roots, &locks).unwrap_err();
        assert!(err.contains("outside the declared write prefixes"), "a root is no destination: {err}");
    }

    #[test]
    fn copy_dir_says_why_a_source_is_no_path_at_all() {
        let (dir, roots) = root();
        let locks = SkillsLocks::default();
        let dst = s(&dir.path().join("dst"));
        let err = copy_dir("relative/skills", &dst, &roots, &locks).unwrap_err();
        assert!(err.contains("must be absolute"), "{err}");
        let err = copy_dir(&format!("{}/a/../skills", s(dir.path())), &dst, &roots, &locks).unwrap_err();
        assert!(err.contains("must not contain .."), "{err}");
    }

    #[test]
    fn copy_dir_refuses_a_fifo_in_the_source_and_writes_nothing() {
        let (dir, roots) = root();
        let src = dir.path().join("src");
        skill_tree(&src);
        let fifo = std::ffi::CString::new(s(&src.join("scripts/pipe"))).unwrap();
        // SAFETY: a NUL-terminated path alive for the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let dst = dir.path().join("dst");
        let err = copy_dir(&s(&src), &s(&dst), &roots, &SkillsLocks::default()).unwrap_err();
        assert!(err.contains("pipe is neither a file nor a directory — nothing was copied"), "{err}");
        assert!(!dst.exists());
    }

    /// What `survey` planned, then `edit` applied to the source before the
    /// copy is made — the window a racing writer has.
    fn made_after(src: &Path, dst: &Path, roots: &[String], edit: impl FnOnce()) -> Result<(), String> {
        let entries = survey(src).unwrap();
        edit();
        make(src, &resolve_entry(&s(dst), roots, "copyDir").unwrap(), &entries)
    }

    #[test]
    fn a_directory_turned_into_a_link_after_the_survey_is_not_read_through() {
        let (dir, roots) = root();
        let src = dir.path().join("src");
        skill_tree(&src);
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(elsewhere.path().join("design-patterns.md"), "secret").unwrap();
        let dst = dir.path().join("dst");
        let made = made_after(&src, &dst, &roots, || {
            fs::rename(src.join("references"), dir.path().join("aside")).unwrap();
            std::os::unix::fs::symlink(elsewhere.path(), src.join("references")).unwrap();
        });
        // Refused at the walk to the file under the swapped directory.
        let err = made.unwrap_err();
        assert!(err.contains("references/design-patterns.md: "), "{err}");
        assert!(!dst.exists(), "the copy that failed is taken back");
    }

    #[test]
    fn a_file_turned_into_a_fifo_after_the_survey_is_refused_at_once() {
        let (dir, roots) = root();
        let src = dir.path().join("src");
        skill_tree(&src);
        let dst = dir.path().join("dst");
        let (done, outcome) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let made = made_after(&src, &dst, &roots, || {
                fs::remove_file(src.join("SKILL.md")).unwrap();
                let fifo = std::ffi::CString::new(s(&src.join("SKILL.md"))).unwrap();
                // SAFETY: a NUL-terminated path alive for the call.
                assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            });
            done.send((made, dst.exists())).unwrap();
        });
        // A blocking open would wait for a writer that never comes.
        let (made, left) = outcome.recv_timeout(std::time::Duration::from_secs(10)).expect("the copy waited on a FIFO");
        assert!(made.unwrap_err().contains("SKILL.md is no longer a file"));
        assert!(!left);
        drop(dir);
    }

    #[test]
    fn a_file_grown_past_the_limit_after_the_survey_is_not_copied() {
        let (dir, roots) = root();
        let src = dir.path().join("src");
        skill_tree(&src);
        let dst = dir.path().join("dst");
        let made = made_after(&src, &dst, &roots, || {
            // Sparse: as large as the limit says, without the disk it names.
            fs::OpenOptions::new().write(true).open(src.join("logo.png")).unwrap().set_len(COPY_MAX_BYTES + 1).unwrap();
        });
        assert!(made.unwrap_err().contains("logo.png grew past what a copy may carry"));
        assert!(!dst.exists());
    }

    #[test]
    fn copy_dir_reads_a_staged_view_only_while_no_stage_holds_it() {
        let (dir, roots) = root();
        let locks = SkillsLocks::default();
        let dst = dir.path().join("plugin/skills");
        let (done, copied) = std::sync::mpsc::channel();
        let (ready, started) = std::sync::mpsc::channel();
        locks.holding("ws-1", || {
            let (copier, into) = (locks.clone(), dst.clone());
            // Its own thread has its own test home, so it stages its view there.
            std::thread::spawn(move || {
                let view = crate::paths::keepdeck_home().unwrap().join("skills/staging/ws-1/skills");
                skill_tree(&view.join("review"));
                ready.send(()).unwrap();
                done.send(copy_dir(&s(&view), &s(&into), &roots, &copier)).unwrap();
            });
            started.recv().unwrap();
            assert!(
                copied.recv_timeout(std::time::Duration::from_millis(300)).is_err(),
                "the view was copied while a stage held it"
            );
            assert!(!dst.exists());
        });
        copied.recv().unwrap().unwrap();
        assert!(dst.join("review/references/design-patterns.md").is_file());
    }

    #[test]
    fn copy_dir_refuses_a_tree_larger_than_a_copy_may_carry() {
        let (dir, roots) = root();
        let locks = SkillsLocks::default();
        let big = dir.path().join("big");
        fs::create_dir(&big).unwrap();
        // Sparse: as large as the limit says, without the disk it names.
        fs::File::create(big.join("huge.bin")).unwrap().set_len(COPY_MAX_BYTES + 1).unwrap();
        let many = dir.path().join("many");
        fs::create_dir(&many).unwrap();
        for n in 0..=COPY_MAX_ENTRIES {
            fs::File::create(many.join(n.to_string())).unwrap();
        }
        for src in [big, many] {
            let dst = dir.path().join("dst");
            let err = copy_dir(&s(&src), &s(&dst), &roots, &locks).unwrap_err();
            assert!(err.contains("more than a copy may carry"), "{err}");
            assert!(!dst.exists());
        }
    }

    #[test]
    fn a_plugin_writes_inside_its_own_grant_and_nowhere_else() {
        let mine = tempfile::tempdir().unwrap();
        let theirs = tempfile::tempdir().unwrap();
        let grants = PluginGrants::default();
        grants.hand_workspace("p.mine", "ws-1", s(mine.path()));
        grants.hand_workspace("p.theirs", "ws-1", s(theirs.path()));

        let roots = roots_of(&grants, "p.mine", "writeFile", "x").unwrap();
        assert!(write_file(s(&theirs.path().join("x")), "x".into(), roots.clone()).is_err());
        write_file(s(&mine.path().join("x")), "x".into(), roots).unwrap();

        let error = roots_of(&grants, "p.nobody", "writeFile", "/tmp/x").unwrap_err();
        assert!(error.starts_with("fsWrite.writeFile: \"/tmp/x\": WRITE_UNDECLARED"), "{error}");
    }
}
