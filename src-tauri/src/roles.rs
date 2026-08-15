//! The role catalog's stored half: the user's role files and their CRUD.
//!
//! One role is one file — `<keepdeck_home>/roles/<id>.json` — the same
//! class of data as the skills library (user-authored content, edited by
//! hand or through the settings dialog) and kept the same way. What the
//! bytes MEAN — field shapes, the id grammar, the merge over the built-in
//! roles — is the webview's business (`src/domain/mail/catalog.ts`); this
//! adapter moves bytes and refuses unsafe path segments, nothing more.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use crate::skills::require_safe;
use crate::state::write_atomic;

/// One stored role on the wire: the id its file NAME carries — so a record
/// cannot disagree with its own address — and the raw JSON content, parsed
/// and judged on the TS side.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleFileDto {
    pub id: String,
    pub content: String,
}

/// Every stored role, ids alphabetical — a deterministic order the manager
/// hands straight to the merge.
#[tauri::command(async)]
pub fn roles_list() -> Result<Vec<RoleFileDto>, String> {
    list(&roles_root()?).map_err(|e| e.to_string())
}

/// Write one role's file. Content is composed and validated by the
/// webview; this side refuses unsafe path segments.
#[tauri::command(async)]
pub fn roles_save(id: String, content: String) -> Result<(), String> {
    save(&roles_root()?, &id, &content)
}

/// Remove one role's file. Missing is fine — it is the outcome asked for.
#[tauri::command(async)]
pub fn roles_delete(id: String) -> Result<(), String> {
    delete(&roles_root()?, &id)
}

fn save(root: &Path, id: &str, content: &str) -> Result<(), String> {
    require_safe(id, "role id")?;
    write_atomic(&root.join(format!("{id}.json")), content.as_bytes()).map_err(|e| e.to_string())
}

fn delete(root: &Path, id: &str) -> Result<(), String> {
    require_safe(id, "role id")?;
    match fs::remove_file(root.join(format!("{id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn list(root: &Path) -> io::Result<Vec<RoleFileDto>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        // No directory yet is an empty catalog, not a failure — the folder
        // appears with the first save.
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut roles = Vec::new();
    for entry in entries {
        let path = entry?.path();
        // Only `<id>.json` FILES with a path-safe stem are records; anything
        // else in the folder — an editor backup, a directory that happens to
        // end in .json — is simply not a role, and could never be addressed
        // as one. An UNSAFE-named .json is skipped too, diverging from the
        // skills library's list-and-refuse policy on purpose: no write
        // command could ever touch such a file (require_safe gates delete as
        // well), so listing it would offer a deletion that cannot work.
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if require_safe(id, "role id").is_err() {
            continue;
        }
        // Read LOSSILY, and the two failure classes part ways. Bad BYTES
        // (a hand edit in the wrong encoding) become a record that will not
        // parse — visible, named in the webview's problems, deletable from
        // its orphan row — instead of a silently absent one whose built-in
        // stand-in invites the very overwrite the manager's gate exists to
        // prevent. A real IO failure propagates: the gate can only refuse
        // to write over what it KNOWS it could not read.
        let content = String::from_utf8_lossy(&fs::read(&path)?).into_owned();
        roles.push(RoleFileDto {
            id: id.to_string(),
            content,
        });
    }
    roles.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(roles)
}

fn roles_root() -> Result<PathBuf, String> {
    let home = crate::paths::keepdeck_home().ok_or("no home directory for roles")?;
    Ok(home.join("roles"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("roles");
        (dir, root)
    }

    #[test]
    fn a_missing_folder_is_an_empty_catalog() {
        let (_tmp, root) = root();
        assert_eq!(list(&root).unwrap(), Vec::new());
    }

    #[test]
    fn saves_lists_and_deletes_one_role_by_its_file() {
        let (_tmp, root) = root();
        save(&root, "docs", "{\"label\":\"Docs\"}").unwrap();
        save(&root, "buddy", "{}").unwrap();
        let listed = list(&root).unwrap();
        // Alphabetical, and the id comes from the file name.
        assert_eq!(
            listed.iter().map(|role| role.id.as_str()).collect::<Vec<_>>(),
            ["buddy", "docs"],
        );
        assert_eq!(listed[1].content, "{\"label\":\"Docs\"}");

        delete(&root, "docs").unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        // Deleting what is already gone is the outcome asked for.
        delete(&root, "docs").unwrap();
    }

    #[test]
    fn refuses_an_unsafe_id_before_touching_the_disk() {
        let (_tmp, root) = root();
        assert!(save(&root, "../escape", "{}").is_err());
        assert!(delete(&root, "a/b").is_err());
        assert!(!root.exists());
    }

    #[test]
    fn lists_only_json_records_with_addressable_names() {
        let (_tmp, root) = root();
        save(&root, "docs", "{}").unwrap();
        fs::write(root.join("notes.txt"), "not a role").unwrap();
        fs::create_dir(root.join("stray.json")).unwrap();
        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "docs");
    }

    #[test]
    fn non_utf8_bytes_become_a_visible_record_rather_than_an_absence() {
        // Propagated, one bad file failed the whole list; SKIPPED, it
        // vanished — its built-in stand-in showed no "edited" badge and
        // invited an overwrite. Listed lossily, the webview sees a record
        // that will not parse, names it, and offers its deletion.
        let (_tmp, root) = root();
        save(&root, "docs", "{}").unwrap();
        fs::write(root.join("binary.json"), [0xff, 0xfe, 0x00]).unwrap();
        let listed = list(&root).unwrap();
        assert_eq!(
            listed.iter().map(|role| role.id.as_str()).collect::<Vec<_>>(),
            ["binary", "docs"],
        );
        // The lossy content is still THERE to fail a JSON parse loudly.
        assert!(listed[0].content.contains('\u{fffd}'));
    }
}
