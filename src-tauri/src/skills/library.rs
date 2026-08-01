//! The skills library on disk: the user's authored skills and their CRUD.
//!
//! One skill is a directory holding `SKILL.md` (assets may ride alongside),
//! under one of two scopes:
//!
//! - `<skills_root>/library/global/<skill>/`
//! - `<skills_root>/library/ws/<wsId>/<skill>/`
//!
//! Nothing here derives, copies or publishes anything — that is
//! [`super::staging`]'s half. This module owns only what the user
//! authored and the rules for naming it safely.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use super::SkillDto;
use crate::state::write_atomic;

pub(crate) const SKILL_FILE: &str = "SKILL.md";

/// Path-segment safety shared by skill names and workspace ids: one plain
/// directory name, no traversal. The friendlier naming rules (kebab-case
/// etc.) are the webview's business.
pub(crate) fn require_safe(segment: &str, what: &str) -> Result<(), String> {
    let ok = !segment.is_empty()
        && segment.len() <= 64
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && segment.starts_with(|c: char| c.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err(format!("unsafe {what}: {segment:?}"))
    }
}

/// The library directory a scope stores its skills in.
pub(crate) fn scope_dir(root: &Path, scope: &str, ws_id: Option<&str>) -> Result<PathBuf, String> {
    match (scope, ws_id) {
        ("global", None) => Ok(root.join("library").join("global")),
        ("workspace", Some(ws)) => {
            require_safe(ws, "workspace id")?;
            Ok(root.join("library").join("ws").join(ws))
        }
        _ => Err(format!("invalid scope: {scope:?} (wsId {ws_id:?})")),
    }
}

pub(crate) fn list(root: &Path) -> io::Result<Vec<SkillDto>> {
    let mut out = Vec::new();
    let library = root.join("library");
    for (name, content) in scope_skills(&library.join("global"))? {
        out.push(SkillDto {
            scope: "global".into(),
            ws_id: None,
            name,
            content,
        });
    }
    for ws in sorted_dirs(&library.join("ws"))? {
        let ws_id = ws.file_name().unwrap_or_default().to_string_lossy().into_owned();
        for (name, content) in scope_skills(&ws)? {
            out.push(SkillDto {
                scope: "workspace".into(),
                ws_id: Some(ws_id.clone()),
                name,
                content,
            });
        }
    }
    Ok(out)
}

/// `(name, SKILL.md content)` per skill directory, names alphabetical.
/// Directories without a `SKILL.md` are not skills and are skipped.
fn scope_skills(dir: &Path) -> io::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for skill in sorted_dirs(dir)? {
        let Ok(content) = fs::read_to_string(skill.join(SKILL_FILE)) else {
            continue;
        };
        let name = skill.file_name().unwrap_or_default().to_string_lossy().into_owned();
        out.push((name, content));
    }
    Ok(out)
}

/// Subdirectories of `dir`, name-sorted; a missing `dir` is just empty.
pub(crate) fn sorted_dirs(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    Ok(dirs)
}

pub(crate) fn save(scope_dir: &Path, name: &str, content: &str) -> io::Result<()> {
    require_safe(name, "skill name").map_err(io::Error::other)?;
    write_atomic(&scope_dir.join(name).join(SKILL_FILE), content.as_bytes())
}

/// Write a skill that must NOT already exist.
///
/// Its own operation rather than a flag on [`save`], because the two differ in
/// what they are allowed to destroy. The webview checks a new name against the
/// library it listed, but that list is empty whenever the backend read failed —
/// and then every name looks free, so the write would silently destroy the
/// skill it collided with.
///
/// "Taken" means a readable skill is there: the SKILL.md, matching what
/// [`scope_skills`] counts as a skill. [`rename`] refuses on the DIRECTORY
/// instead, so a leftover directory with no SKILL.md blocks a rename and
/// accepts a create — deliberate, since a create can fill it in and a rename
/// would bury whatever else it holds.
pub(crate) fn create(scope_dir: &Path, name: &str, content: &str) -> io::Result<()> {
    require_safe(name, "skill name").map_err(io::Error::other)?;
    if scope_dir.join(name).join(SKILL_FILE).exists() {
        return Err(io::Error::other(format!(
            "a skill named {name:?} already exists"
        )));
    }
    save(scope_dir, name, content)
}

pub(crate) fn delete(scope_dir: &Path, name: &str) -> io::Result<()> {
    require_safe(name, "skill name").map_err(io::Error::other)?;
    match fs::remove_dir_all(scope_dir.join(name)) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

pub(crate) fn rename(scope_dir: &Path, from: &str, to: &str) -> io::Result<()> {
    require_safe(from, "skill name").map_err(io::Error::other)?;
    require_safe(to, "skill name").map_err(io::Error::other)?;
    let target = scope_dir.join(to);
    if target.exists() {
        return Err(io::Error::other(format!("a skill named {to:?} already exists")));
    }
    fs::rename(scope_dir.join(from), target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::test_support::{global, root, ws};

    #[test]
    fn save_list_roundtrip_orders_global_before_workspaces() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-2"), "review", "ws two").unwrap();
        save(&global(&root), "review", "global review").unwrap();
        save(&global(&root), "deploy", "global deploy").unwrap();

        let all = list(&root).unwrap();
        let brief: Vec<(&str, Option<&str>, &str)> = all
            .iter()
            .map(|s| (s.scope.as_str(), s.ws_id.as_deref(), s.name.as_str()))
            .collect();
        assert_eq!(
            brief,
            vec![
                ("global", None, "deploy"),
                ("global", None, "review"),
                ("workspace", Some("ws-2"), "review"),
            ]
        );
        assert_eq!(all[1].content, "global review");

        // The wire shape the webview reads — pin the camelCase field.
        let json = serde_json::to_value(&all[2]).unwrap();
        assert_eq!(json["wsId"], "ws-2");
        assert_eq!(json["scope"], "workspace");
    }

    #[test]
    fn unsafe_names_are_refused() {
        let (_tmp, root) = root();
        for bad in ["", "../evil", "a/b", ".hidden", "-lead", &"x".repeat(65)] {
            assert!(save(&global(&root), bad, "x").is_err(), "accepted {bad:?}");
        }
        assert!(scope_dir(&root, "workspace", Some("../up")).is_err());
        assert!(scope_dir(&root, "workspace", None).is_err());
        assert!(scope_dir(&root, "other", None).is_err());
    }

    #[test]
    fn rename_moves_the_whole_directory_and_refuses_collisions() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "content").unwrap();
        fs::write(global(&root).join("review").join("notes.txt"), "asset").unwrap();
        save(&global(&root), "deploy", "other").unwrap();

        rename(&global(&root), "review", "deep-review").unwrap();
        let moved = global(&root).join("deep-review");
        assert_eq!(fs::read_to_string(moved.join(SKILL_FILE)).unwrap(), "content");
        assert_eq!(fs::read_to_string(moved.join("notes.txt")).unwrap(), "asset");
        assert!(!global(&root).join("review").exists());

        // Onto an existing skill — refused, both survive untouched.
        assert!(rename(&global(&root), "deep-review", "deploy").is_err());
        assert!(moved.exists());
        assert_eq!(
            fs::read_to_string(global(&root).join("deploy").join(SKILL_FILE)).unwrap(),
            "other",
        );
        assert!(rename(&global(&root), "deep-review", "../up").is_err());
    }

    #[test]
    fn save_overwrites_and_delete_removes() {
        let (_tmp, root) = root();
        save(&global(&root), "review", "v1").unwrap();
        save(&global(&root), "review", "v2").unwrap();
        assert_eq!(list(&root).unwrap()[0].content, "v2");

        delete(&global(&root), "review").unwrap();
        assert!(list(&root).unwrap().is_empty());
        delete(&global(&root), "review").unwrap(); // missing is fine
    }

    #[test]
    fn create_refuses_a_name_that_is_taken_but_save_still_overwrites() {
        // The webview gates a create on the library it listed, and that list
        // degrades to empty whenever the backend read fails — so every name
        // looks free and the write lands on top of a real skill. An edit of an
        // existing skill is a legitimate overwrite and must stay one.
        let (_tmp, root) = root();
        create(&global(&root), "review", "original").unwrap();

        let err = create(&global(&root), "review", "clobber").unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(list(&root).unwrap()[0].content, "original");

        save(&global(&root), "review", "edited").unwrap();
        assert_eq!(list(&root).unwrap()[0].content, "edited");
    }

    #[test]
    fn create_refuses_unsafe_names_like_save() {
        let (_tmp, root) = root();
        assert!(create(&global(&root), "../escape", "x").is_err());
    }
}
