//! Open a URL or a file path that was Cmd+clicked in terminal output
//! ([F14] URLs, [F10] file paths), and open an agent's working directory in
//! Visual Studio Code. Goes through the opener plugin's Rust API so paths open
//! with the OS default app (or a named app) without needing a JS-side path scope.

use tauri_plugin_opener::OpenerExt;

/// Application name for Visual Studio Code, passed to the opener as the app to
/// open with. On macOS this becomes `open -a "Visual Studio Code" <dir>`, so it
/// launches VS Code even from a GUI-started `.app` whose PATH lacks the `code`
/// CLI, and regardless of the folder's own default handler.
const VS_CODE_APP: &str = "Visual Studio Code";

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

/// Open a directory — an agent's working dir — in Visual Studio Code.
#[tauri::command]
pub fn open_in_editor(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(expand_tilde(path), Some(VS_CODE_APP))
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

#[cfg(test)]
mod tests {
    use super::expand_tilde;

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
