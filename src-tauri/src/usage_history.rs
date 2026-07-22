//! `usage-history.jsonl` — durable, append-only pane-usage deltas.
//!
//! The webview owns schema, deduplication, retention and aggregation. Native
//! only provides ordered fsynced appends plus atomic compaction, matching the
//! session journal's durability rules without coupling the two domains.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

const USAGE_HISTORY_FILE: &str = "usage-history.jsonl";

#[tauri::command(async)]
pub fn usage_history_load() -> Result<Vec<String>, String> {
    load(&usage_history_path()?).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn usage_history_append(lines: Vec<String>) -> Result<(), String> {
    append(&usage_history_path()?, &lines).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn usage_history_compact(lines: Vec<String>) -> Result<(), String> {
    let joined = join(&lines).map_err(|error| error.to_string())?;
    crate::state::write_atomic(&usage_history_path()?, joined.as_bytes())
        .map_err(|error| error.to_string())
}

fn usage_history_path() -> Result<PathBuf, String> {
    let dir = crate::paths::keepdeck_home().ok_or("no home directory for app state")?;
    Ok(dir.join(USAGE_HISTORY_FILE))
}

fn load(path: &Path) -> io::Result<Vec<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn append(path: &Path, lines: &[String]) -> io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    let joined = join(lines)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(joined.as_bytes())?;
    file.sync_all()
}

fn join(lines: &[String]) -> io::Result<String> {
    let mut joined = String::new();
    for line in lines {
        if line.contains('\n') {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "usage history line contains a newline",
            ));
        }
        joined.push_str(line);
        joined.push('\n');
    }
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_history_is_empty_and_appends_are_ordered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(USAGE_HISTORY_FILE);
        assert!(load(&path).unwrap().is_empty());
        append(&path, &["{\"id\":1}".into()]).unwrap();
        append(&path, &["{\"id\":2}".into()]).unwrap();
        assert_eq!(
            load(&path).unwrap(),
            vec!["{\"id\":1}", "{\"id\":2}"]
        );
    }

    #[test]
    fn embedded_newlines_are_rejected_before_file_creation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(USAGE_HISTORY_FILE);
        assert!(append(&path, &["one\ntwo".into()]).is_err());
        assert!(!path.exists());
    }
}
