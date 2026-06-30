//! Open a URL or a file path that was Cmd+clicked in terminal output
//! ([F14] URLs, [F10] file paths). Goes through the opener plugin's Rust API so
//! the path opens with the OS default app without needing a JS-side path scope.

use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(expand_tilde(path), None::<&str>)
        .map_err(|e| e.to_string())
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
