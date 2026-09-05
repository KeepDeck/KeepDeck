//! The user's library of MCP servers: the bytes on disk, and nothing else.
//!
//! `<home>/mcp/library/{global,ws/<wsId>}/<name>.json` — one file per server,
//! the way the skills library keeps one directory per skill; the NAME is the
//! filename, so the two can never drift. The webview owns the schema (what a
//! server body is, what makes a name acceptable to every client); this side
//! moves bytes, refuses unsafe path segments, and keeps each file private —
//! a server's file may hold a credential, which is also why the library sits
//! under `<home>/mcp`, the directory the transport forces to 0700.
//!
//! Mechanical on purpose, and the twin of `skills/library.rs`: list, save,
//! create, delete, rename — each opening with the shared path wall. The four
//! commands live HERE, with the bytes they move, for the reason `arming.rs`
//! gives: the transport's module door wires the socket, the bridge and the
//! shim, and a second feature parked there is how its predecessor grew.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use crate::state::write_atomic_mode;

const SERVER_FILE_EXT: &str = "json";
/// Owner-only from the first byte: the file may hold a token.
const SERVER_FILE_MODE: u32 = 0o600;

/// One library server on the wire (mirrors the TS `StoredMcpServer`,
/// camelCase). Content rides along — servers are small and the list IS the
/// read path, as with skills.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDto {
    pub scope: String,
    pub ws_id: Option<String>,
    pub name: String,
    pub content: String,
}

/// Path-segment safety, judged by the ONE shared wall (`fs_names`); this
/// wrapper keeps the library's error wording.
fn require_safe(segment: &str, what: &str) -> Result<(), String> {
    if crate::fs_names::is_safe_segment(segment) {
        Ok(())
    } else {
        Err(format!("unsafe {what}: {segment:?}"))
    }
}

/// The directory a scope stores its servers in.
pub(super) fn scope_dir(root: &Path, scope: &str, ws_id: Option<&str>) -> Result<PathBuf, String> {
    match (scope, ws_id) {
        ("global", None) => Ok(root.join("global")),
        ("workspace", Some(ws)) => {
            require_safe(ws, "workspace id")?;
            Ok(root.join("ws").join(ws))
        }
        _ => Err(format!("invalid scope: {scope:?} (wsId {ws_id:?})")),
    }
}

fn server_file(scope_dir: &Path, name: &str) -> PathBuf {
    scope_dir.join(format!("{name}.{SERVER_FILE_EXT}"))
}

/// Every server in the library, global scope first, then workspaces, names
/// alphabetical — a deterministic order the UI can render as-is.
pub(super) fn list(root: &Path) -> io::Result<Vec<McpServerDto>> {
    let mut out = Vec::new();
    for (name, content) in scope_servers(&root.join("global"))? {
        out.push(McpServerDto {
            scope: "global".into(),
            ws_id: None,
            name,
            content,
        });
    }
    for ws in crate::fs_names::sorted_dirs(&root.join("ws"))? {
        let ws_id = ws.file_name().unwrap_or_default().to_string_lossy().into_owned();
        for (name, content) in scope_servers(&ws)? {
            out.push(McpServerDto {
                scope: "workspace".into(),
                ws_id: Some(ws_id.clone()),
                name,
                content,
            });
        }
    }
    Ok(out)
}

/// `(name, file content)` per `<name>.json` in `dir`, names alphabetical. A
/// missing dir is just empty. Anything else in the directory is not a server
/// and is skipped; so is a file that cannot be read as text — the webview
/// judges the CONTENT, this side only judges that there is some.
///
/// A name no WRITE could accept is still listed, for the reason the skills
/// library gives: hidden, it would still be handed to the injection while
/// the app denied it existed; listed, every write refuses it loudly.
fn scope_servers(dir: &Path) -> io::Result<Vec<(String, String)>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some(SERVER_FILE_EXT) {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        out.push((name.to_string(), content));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

pub(super) fn save(scope_dir: &Path, name: &str, content: &str) -> io::Result<()> {
    require_safe(name, "server name").map_err(io::Error::other)?;
    write_atomic_mode(&server_file(scope_dir, name), content.as_bytes(), Some(SERVER_FILE_MODE))
}

/// Write a server that must NOT already exist — the guard that holds when the
/// webview's own collision check ran against a library it could not read.
pub(super) fn create(scope_dir: &Path, name: &str, content: &str) -> io::Result<()> {
    require_safe(name, "server name").map_err(io::Error::other)?;
    if server_file(scope_dir, name).exists() {
        return Err(io::Error::other(format!(
            "a server named {name:?} already exists"
        )));
    }
    save(scope_dir, name, content)
}

/// Remove one server's file. Missing is fine.
pub(super) fn delete(scope_dir: &Path, name: &str) -> io::Result<()> {
    require_safe(name, "server name").map_err(io::Error::other)?;
    match fs::remove_file(server_file(scope_dir, name)) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Rename by moving the file. Refuses to move onto an existing server.
pub(super) fn rename(scope_dir: &Path, from: &str, to: &str) -> io::Result<()> {
    require_safe(from, "server name").map_err(io::Error::other)?;
    require_safe(to, "server name").map_err(io::Error::other)?;
    let target = server_file(scope_dir, to);
    if target.exists() {
        return Err(io::Error::other(format!("a server named {to:?} already exists")));
    }
    fs::rename(server_file(scope_dir, from), target)
}

fn library_root() -> Result<PathBuf, String> {
    crate::paths::mcp_library().ok_or_else(|| "no home directory for the MCP library".to_string())
}

/// Every server in the library, in the order [`list`] gives.
#[tauri::command(async)]
pub fn mcp_library_list() -> Result<Vec<McpServerDto>, String> {
    list(&library_root()?).map_err(|e| e.to_string())
}

/// Write one server's file (content is composed and validated by the webview;
/// this side refuses unsafe path segments — and, when the caller says this is
/// a CREATE, a name that is already taken).
#[tauri::command(async)]
pub fn mcp_library_save(
    scope: String,
    ws_id: Option<String>,
    name: String,
    content: String,
    expect_new: bool,
) -> Result<(), String> {
    let dir = scope_dir(&library_root()?, &scope, ws_id.as_deref())?;
    let written = if expect_new {
        create(&dir, &name, &content)
    } else {
        save(&dir, &name, &content)
    };
    written.map_err(|e| e.to_string())
}

/// Remove one server. Missing is fine.
#[tauri::command(async)]
pub fn mcp_library_delete(scope: String, ws_id: Option<String>, name: String) -> Result<(), String> {
    let dir = scope_dir(&library_root()?, &scope, ws_id.as_deref())?;
    delete(&dir, &name).map_err(|e| e.to_string())
}

/// Rename one server. Refuses to move onto an existing one.
#[tauri::command(async)]
pub fn mcp_library_rename(
    scope: String,
    ws_id: Option<String>,
    from: String,
    to: String,
) -> Result<(), String> {
    let dir = scope_dir(&library_root()?, &scope, ws_id.as_deref())?;
    rename(&dir, &from, &to).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        (dir, root)
    }

    fn global(root: &Path) -> PathBuf {
        root.join("global")
    }

    fn ws(root: &Path, id: &str) -> PathBuf {
        root.join("ws").join(id)
    }

    #[test]
    fn save_list_roundtrip_orders_global_before_workspaces() {
        let (_tmp, root) = root();
        save(&ws(&root, "ws-2"), "github", "{ws two}").unwrap();
        save(&global(&root), "github", "{global github}").unwrap();
        save(&global(&root), "fs", "{global fs}").unwrap();

        let all = list(&root).unwrap();
        let brief: Vec<(&str, Option<&str>, &str)> = all
            .iter()
            .map(|s| (s.scope.as_str(), s.ws_id.as_deref(), s.name.as_str()))
            .collect();
        assert_eq!(
            brief,
            vec![
                ("global", None, "fs"),
                ("global", None, "github"),
                ("workspace", Some("ws-2"), "github"),
            ]
        );
        assert_eq!(all[1].content, "{global github}");

        // The wire shape the webview reads — pin the camelCase field.
        let json = serde_json::to_value(&all[2]).unwrap();
        assert_eq!(json["wsId"], "ws-2");
        assert_eq!(json["scope"], "workspace");
    }

    #[test]
    fn a_missing_library_lists_empty() {
        let (_tmp, root) = root();
        assert_eq!(list(&root).unwrap(), Vec::<McpServerDto>::new());
    }

    #[test]
    fn only_server_files_are_servers() {
        // A stray note, a directory, an editor backup — none of them is a
        // server, and none may reach the injection as one.
        let (_tmp, root) = root();
        save(&global(&root), "github", "{}").unwrap();
        fs::write(global(&root).join("README.md"), "notes").unwrap();
        fs::write(global(&root).join("github.json.bak"), "{}").unwrap();
        fs::create_dir_all(global(&root).join("nested.json")).unwrap();

        let names: Vec<String> = list(&root).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["github".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_server_file_is_private_to_its_owner() {
        // The file may hold a token. Owner-only, and from the first byte —
        // the mode is set on the temp file before the content lands.
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, root) = root();
        save(&global(&root), "github", "{\"token\":\"x\"}").unwrap();
        let mode = fs::metadata(global(&root).join("github.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn unsafe_names_are_refused() {
        let (_tmp, root) = root();
        for bad in ["", "../evil", "a/b", ".hidden", "-lead", &"x".repeat(65)] {
            assert!(save(&global(&root), bad, "{}").is_err(), "accepted {bad:?}");
        }
        assert!(scope_dir(&root, "workspace", Some("../up")).is_err());
        assert!(scope_dir(&root, "workspace", None).is_err());
        assert!(scope_dir(&root, "other", None).is_err());
    }

    #[test]
    fn create_refuses_a_taken_name_and_save_overwrites() {
        let (_tmp, root) = root();
        create(&global(&root), "github", "{v1}").unwrap();
        assert!(create(&global(&root), "github", "{v2}").is_err());
        assert_eq!(list(&root).unwrap()[0].content, "{v1}");

        save(&global(&root), "github", "{v2}").unwrap();
        assert_eq!(list(&root).unwrap()[0].content, "{v2}");
    }

    #[test]
    fn delete_removes_and_tolerates_absence() {
        let (_tmp, root) = root();
        save(&global(&root), "github", "{}").unwrap();
        delete(&global(&root), "github").unwrap();
        assert!(list(&root).unwrap().is_empty());
        delete(&global(&root), "github").unwrap();
        assert!(delete(&global(&root), "../up").is_err());
    }

    #[test]
    fn rename_moves_the_file_and_refuses_collisions() {
        let (_tmp, root) = root();
        save(&global(&root), "github", "{gh}").unwrap();
        save(&global(&root), "fs", "{fs}").unwrap();

        rename(&global(&root), "github", "github-remote").unwrap();
        let names: Vec<String> = list(&root).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["fs".to_string(), "github-remote".to_string()]);

        // Onto an existing server — refused, both survive untouched.
        assert!(rename(&global(&root), "github-remote", "fs").is_err());
        assert_eq!(list(&root).unwrap()[0].content, "{fs}");
        assert_eq!(list(&root).unwrap()[1].content, "{gh}");
        assert!(rename(&global(&root), "github-remote", "../up").is_err());
    }
}
