//! Open a URL or a file path that was Cmd+clicked in terminal output
//! ([F14] URLs, [F10] file paths), or a path in a named application (the
//! opener service's `openPathWith`). Goes through the opener plugin's Rust API
//! so paths open with the OS default app (or a named app) without needing a
//! JS-side path scope.

use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

/// Why an open failed, sent to the webview as the command's structured
/// rejection so the click path can tell "the file is gone" ([F16]) apart from
/// a generic opener failure. Wire shape (narrowed in `src/domain/terminal/links.ts`):
/// `{ kind: "notFound", path }` | `{ kind: "failed", message }`.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenError {
    NotFound { path: String },
    Failed { message: String },
}

#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), OpenError> {
    let path = ensure_exists(expand_tilde(path))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| OpenError::Failed {
            message: e.to_string(),
        })
}

/// Report a missing file explicitly ([F16]) — the opener isn't trusted to fail
/// on one (macOS `open` may pop its own dialog or silently no-op), and terminal
/// output routinely names paths that have since been deleted.
fn ensure_exists(path: String) -> Result<String, OpenError> {
    if std::path::Path::new(&path).exists() {
        Ok(path)
    } else {
        Err(OpenError::NotFound { path })
    }
}

/// Open a path in a named application — `application` is the app's name as the
/// OS resolves it (macOS: the `open -a` argument), so a caller can target any
/// app the user configured instead of one hardcoded here.
#[tauri::command]
pub fn open_path_with(
    app: tauri::AppHandle,
    path: String,
    application: String,
) -> Result<(), OpenError> {
    let path = ensure_exists(expand_tilde(path))?;
    app.opener()
        .open_path(path, Some(application.as_str()))
        .map_err(|e| OpenError::Failed {
            message: e.to_string(),
        })
}

/// Expand a leading `~/` to `$HOME` — the opener doesn't go through a shell, so a
/// literal `~` wouldn't resolve.
fn expand_tilde(path: String) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME") {
            Some(home) => format!("{}/{}", home.to_string_lossy(), rest),
            None => path,
        },
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::{ensure_exists, expand_tilde, OpenError};

    #[test]
    fn ensure_exists_passes_an_existing_path_through() {
        let here = env!("CARGO_MANIFEST_DIR").to_string();
        assert_eq!(ensure_exists(here.clone()), Ok(here));
    }

    #[test]
    fn ensure_exists_reports_a_missing_path_as_not_found() {
        let gone = format!("{}/no-such-file-f16.txt", env!("CARGO_MANIFEST_DIR"));
        assert_eq!(
            ensure_exists(gone.clone()),
            Err(OpenError::NotFound { path: gone })
        );
    }

    // The webview narrows on this exact JSON shape (src/domain/terminal/links.ts) — pin it.
    #[test]
    fn open_error_serializes_with_camel_case_kind_tag() {
        let not_found = OpenError::NotFound { path: "/x".into() };
        assert_eq!(
            serde_json::to_value(&not_found).unwrap(),
            serde_json::json!({ "kind": "notFound", "path": "/x" })
        );
        let failed = OpenError::Failed { message: "boom".into() };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({ "kind": "failed", "message": "boom" })
        );
    }

    #[test]
    fn expands_leading_tilde_slash_to_home() {
        if let Some(home) = std::env::var_os("HOME") {
            let home = home.to_string_lossy();
            assert_eq!(expand_tilde("~/proj/dir".into()), format!("{home}/proj/dir"));
        }
    }

    #[test]
    fn leaves_non_tilde_paths_untouched() {
        // Absolute and relative paths pass through verbatim...
        assert_eq!(expand_tilde("/abs/path".into()), "/abs/path");
        assert_eq!(expand_tilde("rel/path".into()), "rel/path");
        // ...and a bare "~" is NOT expanded (only the "~/" prefix is).
        assert_eq!(expand_tilde("~".into()), "~");
        assert_eq!(expand_tilde("~user/x".into()), "~user/x");
    }
}
