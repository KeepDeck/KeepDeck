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

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Component, Path, PathBuf};

#[tauri::command(async)]
pub fn plugins_fs_write_mkdir(path: String, roots: Vec<String>) -> Result<(), String> {
    let target = resolve_write(&path, &roots)?;
    fs::create_dir_all(&target).map_err(|e| e.to_string())
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
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn plugins_fs_write_file(
    path: String,
    text: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let target = resolve_write(&path, &roots)?;
    crate::state::write_atomic(&target, text.as_bytes()).map_err(|e| e.to_string())
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
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{line}\n").as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}

/// Expand a leading `~/` to the user's home directory.
fn expand_home(path: &str) -> Result<PathBuf, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var_os("HOME").ok_or("no home directory")?;
        return Ok(PathBuf::from(home).join(rest));
    }
    Ok(PathBuf::from(path))
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

fn resolve_write(path: &str, roots: &[String]) -> Result<PathBuf, String> {
    let real = realize(&expand_home(path)?)?;
    for root in roots {
        let expanded = expand_home(root)?;
        let root_real = fs::canonicalize(&expanded).unwrap_or(expanded);
        if real.starts_with(&root_real) {
            return Ok(real);
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
