//! `journal.jsonl` — the workspace session journal's event log ([F8]).
//!
//! Unlike the opaque JSON *documents* in `crate::state`, this is an append-
//! only line log: a save appends encoded event lines instead of rewriting the
//! file, so every event is durable the moment it happened (no debounce loss,
//! no quit race) and a crash can tear at most the final line — which the
//! webview-side decoder skips. All schema knowledge (codec, folding, per-line
//! versioning, compaction policy) lives in `src/domain/journal`; these
//! commands only move bytes.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::PathBuf;

const JOURNAL_FILE: &str = "journal.jsonl";

/// Every stored line, in order (empty on first run). A torn final line is
/// returned as-is — classifying it is the decoder's job, not ours.
#[tauri::command(async)]
pub fn journal_load() -> Result<Vec<String>, String> {
    load(&journal_path()?).map_err(|e| e.to_string())
}

/// Append encoded lines as one write, synced to disk before returning.
#[tauri::command(async)]
pub fn journal_append(lines: Vec<String>) -> Result<(), String> {
    append(&journal_path()?, &lines).map_err(|e| e.to_string())
}

/// Rewrite the whole log (compaction) with the same atomicity as a document
/// save. The frontend serializes this against appends — it never issues both
/// concurrently.
#[tauri::command(async)]
pub fn journal_compact(lines: Vec<String>) -> Result<(), String> {
    let joined = join(&lines).map_err(|e| e.to_string())?;
    crate::state::write_atomic(&journal_path()?, joined.as_bytes())
        .map_err(|e| e.to_string())
}

fn journal_path() -> Result<PathBuf, String> {
    let dir = crate::paths::keepdeck_home().ok_or("no home directory for app state")?;
    Ok(dir.join(JOURNAL_FILE))
}

fn load(path: &std::path::Path) -> io::Result<Vec<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_owned)
            .collect()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn append(path: &std::path::Path, lines: &[String]) -> io::Result<()> {
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

/// One line per event, each newline-terminated. A caller-supplied embedded
/// newline would silently split one event into a valid line plus garbage —
/// reject it loudly instead.
fn join(lines: &[String]) -> io::Result<String> {
    let mut out = String::new();
    for line in lines {
        if line.contains('\n') {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "journal line contains a newline",
            ));
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join("journal.jsonl")).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn append_accumulates_lines_and_load_skips_blank_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        append(&path, &["{\"e\":1}".into()]).unwrap();
        append(&path, &["{\"e\":2}".into(), "{\"e\":3}".into()]).unwrap();
        fs::write(&path, fs::read_to_string(&path).unwrap() + "\n\n").unwrap();
        assert_eq!(load(&path).unwrap(), vec!["{\"e\":1}", "{\"e\":2}", "{\"e\":3}"]);
    }

    #[test]
    fn append_rejects_embedded_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        assert!(append(&path, &["a\nb".into()]).is_err());
        assert!(!path.exists());
    }
}
