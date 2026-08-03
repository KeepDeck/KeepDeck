//! Shared mechanics for append-only JSONL logs in the KeepDeck home dir.
//!
//! The webview owns each log's schema, deduplication, retention and
//! aggregation. Native provides exactly three verbs — ordered fsynced
//! appends, whole-file load, atomic compaction — identical across logs, so
//! every log's command set delegates here instead of copying the rules.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

pub fn log_path(file: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::keepdeck_home().ok_or("no home directory for app state")?;
    Ok(dir.join(file))
}

pub fn load(path: &Path) -> io::Result<Vec<String>> {
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

pub fn append(path: &Path, lines: &[String]) -> io::Result<()> {
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

pub fn join(lines: &[String]) -> io::Result<String> {
    let mut joined = String::new();
    for line in lines {
        if line.contains('\n') {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "log line contains a newline",
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
    fn missing_log_is_empty_and_appends_are_ordered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        assert!(load(&path).unwrap().is_empty());
        append(&path, &["{\"id\":1}".into()]).unwrap();
        append(&path, &["{\"id\":2}".into()]).unwrap();
        assert_eq!(load(&path).unwrap(), vec!["{\"id\":1}", "{\"id\":2}"]);
    }

    #[test]
    fn embedded_newlines_are_rejected_before_file_creation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        assert!(append(&path, &["one\ntwo".into()]).is_err());
        assert!(!path.exists());
    }
}
