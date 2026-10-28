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
//! directories it was handed) — never taken from the caller.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Component, Path, PathBuf};

use tauri::State;

use crate::containment::expand_home;
use crate::plugin_permissions::PluginGrants;

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
