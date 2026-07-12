//! Enumerate installed applications for the settings' in-app application
//! picker: `.app` bundles under the standard application folders — global,
//! system, and per-user (`~/Applications`, where JetBrains Toolbox and other
//! per-user installers put things the native open dialog never surfaces
//! unprompted). One vendor level deep, so bundles inside a subfolder
//! (`/Applications/Utilities`, a Toolbox folder) are found too. Yields display
//! NAMES, not paths: the opener resolves a name via LaunchServices (`open -a`)
//! wherever the bundle lives.

use std::path::{Path, PathBuf};

#[tauri::command]
pub fn list_applications() -> Vec<String> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    collect_apps(&roots)
}

/// The bundle names under `roots`, one vendor level deep — sorted
/// case-insensitively, exact duplicates (the same app visible from two roots)
/// collapsed.
fn collect_apps(roots: &[PathBuf]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = app_name(&path) {
                names.push(name);
            } else if path.is_dir() {
                let Ok(children) = std::fs::read_dir(&path) else {
                    continue;
                };
                names.extend(children.flatten().filter_map(|c| app_name(&c.path())));
            }
        }
    }
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup();
    names
}

/// The display name when `path` is an application bundle: a DIRECTORY (the
/// check follows symlinks, so a linked bundle counts; a plain file that merely
/// ends in `.app` does not) with the `.app` extension, minus that extension.
fn app_name(path: &Path) -> Option<String> {
    if !path.is_dir() || path.extension()? != "app" {
        return None;
    }
    Some(path.file_stem()?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::collect_apps;

    fn touch(path: &std::path::Path) {
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn finds_bundles_across_roots_one_vendor_level_deep() {
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("Applications");
        let user = dir.path().join("home/Applications");
        std::fs::create_dir_all(global.join("Alpha.app")).unwrap();
        std::fs::create_dir_all(global.join("Utilities/Beta.app")).unwrap();
        std::fs::create_dir_all(user.join("Android Studio.app")).unwrap();
        // Not bundles: a plain FILE named like one, and a loose directory.
        touch(&global.join("fake.app"));
        std::fs::create_dir_all(global.join("Chrome Apps.localized")).unwrap();

        assert_eq!(
            collect_apps(&[global, user]),
            vec!["Alpha", "Android Studio", "Beta"],
        );
    }

    #[test]
    fn sorts_case_insensitively_and_collapses_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        // The same app visible from two roots, plus a lowercase neighbor that
        // must interleave alphabetically rather than sort after every capital.
        std::fs::create_dir_all(a.join("Zed.app")).unwrap();
        std::fs::create_dir_all(b.join("Zed.app")).unwrap();
        std::fs::create_dir_all(a.join("iTerm.app")).unwrap();

        assert_eq!(collect_apps(&[a, b]), vec!["iTerm", "Zed"]);
    }

    #[test]
    fn missing_roots_are_skipped_quietly() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("apps");
        std::fs::create_dir_all(present.join("Solo.app")).unwrap();

        assert_eq!(
            collect_apps(&[dir.path().join("nope"), present]),
            vec!["Solo"],
        );
    }
}
