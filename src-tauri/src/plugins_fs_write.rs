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

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Component, Path, PathBuf};

use crate::containment::expand_home;

#[tauri::command(async)]
pub fn plugins_fs_write_mkdir(path: String, roots: Vec<String>) -> Result<(), String> {
    let target = resolve_write(&path, &roots)?;
    create_dirs_owner_only(&target.path, &target.root)
}

#[tauri::command(async)]
pub fn plugins_fs_write_copy(
    src: String,
    dst: String,
    roots: Vec<String>,
) -> Result<(), String> {
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
    fs::copy(&from.path, &to.path).map_err(|e| e.to_string())?;
    // The copy inherits the SOURCE's mode, which says nothing about where it
    // is landing.
    restrict_file(&to.path);
    Ok(())
}

#[tauri::command(async)]
pub fn plugins_fs_write_file(
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

#[tauri::command(async)]
pub fn plugins_fs_write_append(
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
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::canonicalize(&existing) {
            Ok(canonical) => {
                let mut real = canonical;
                for part in rest.iter().rev() {
                    real.push(part);
                }
                return Ok(real);
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                // A DANGLING symlink also canonicalizes to NotFound — but it
                // exists, and creating "through" it follows the link to
                // wherever it points, outside the proof this function is.
                // (The atomic write path replaced the link itself, by
                // accident of its temp-rename; append followed it.)
                if fs::symlink_metadata(&existing).is_ok() {
                    return Err(format!(
                        "path passes through a broken symlink: {}",
                        existing.display()
                    ));
                }
                let Some(parent) = existing.parent() else {
                    return Err("path has no existing ancestor".into());
                };
                if let Some(name) = existing.file_name() {
                    rest.push(name.to_os_string());
                }
                existing = parent.to_path_buf();
            }
            Err(e) => return Err(e.to_string()),
        }
    }
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
        plugins_fs_write_file(
            inside.to_string_lossy().into_owned(),
            "hi".into(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&inside).unwrap(), "hi");

        let err = plugins_fs_write_file("/tmp/elsewhere.txt".into(), "x".into(), roots)
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
        plugins_fs_write_file(
            file.to_string_lossy().into_owned(),
            "transcript".into(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(mode_of(&scratch), DIR_MODE);
        assert_eq!(mode_of(&file), FILE_MODE);

        let appended = scratch.join("log.txt");
        plugins_fs_write_append(
            appended.to_string_lossy().into_owned(),
            "line".into(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(mode_of(&appended), FILE_MODE);

        let copied = scratch.join("copy.json");
        plugins_fs_write_copy(
            file.to_string_lossy().into_owned(),
            copied.to_string_lossy().into_owned(),
            roots,
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

        let err = plugins_fs_write_append(
            link.to_string_lossy().into_owned(),
            "stolen line".into(),
            roots.clone(),
        )
        .unwrap_err();
        assert!(err.contains("broken symlink"), "{err}");
        assert!(!outside.exists(), "the write followed the link");

        let err = plugins_fs_write_file(
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

        plugins_fs_write_file(
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
        plugins_fs_write_file(
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

        plugins_fs_write_file(
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
            let err = plugins_fs_write_file(
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
        assert!(plugins_fs_write_file(sneaky, "x".into(), roots).is_err());
    }

    #[test]
    fn a_symlink_escaping_the_root_is_refused() {
        let (dir, roots) = root();
        let outside = tempfile::tempdir().unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let through = link.join("file.txt");
        let err = plugins_fs_write_file(
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
        plugins_fs_write_copy(
            src.to_string_lossy().into_owned(),
            dst.to_string_lossy().into_owned(),
            roots.clone(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "data");

        // Reading from outside the prefixes must refuse, even to a valid dst.
        let foreign = tempfile::tempdir().unwrap();
        let outside_src = foreign.path().join("secret.txt");
        fs::write(&outside_src, "secret").unwrap();
        assert!(plugins_fs_write_copy(
            outside_src.to_string_lossy().into_owned(),
            dir.path().join("stolen.txt").to_string_lossy().into_owned(),
            roots,
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
        let err = plugins_fs_write_copy(p.clone(), p, roots).unwrap_err();
        assert!(err.contains("same file"), "{err}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "line1\nline2\n");
    }

    #[test]
    fn append_accumulates_and_rejects_newlines() {
        let (dir, roots) = root();
        let file = dir.path().join("index.jsonl");
        let p = file.to_string_lossy().into_owned();
        plugins_fs_write_append(p.clone(), "{\"a\":1}".into(), roots.clone()).unwrap();
        plugins_fs_write_append(p.clone(), "{\"b\":2}".into(), roots.clone()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
        assert!(plugins_fs_write_append(p, "a\nb".into(), roots).is_err());
    }
}
