//! Shared filesystem-directory watching — the one watcher primitive and the
//! one keyed registry, used by BOTH the worktree HEAD watcher (`head_watch`)
//! and the project-file watcher (`project_fs`). Rather than each feature
//! hand-rolling a `notify` watcher and a `Mutex<HashMap<_, Watcher>>`, they
//! share this.
//!
//! Watching is passive: the OS notifies us (FSEvents on macOS, inotify on
//! Linux), and we hold NO handle on the watched files. So a watched directory
//! — a gitdir, a project folder open in the tree — is never blocked or slowed,
//! and git, agents and the user run unaffected.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

/// Watch `dir` NON-RECURSIVELY, invoking `on_event` for every filesystem event
/// the OS reports on it; the caller filters by `event.kind`/`event.paths`
/// inside the closure. Non-recursive on purpose: a watcher over one
/// directory-of-interest must never descend into a large subtree it doesn't
/// care about (a `node_modules`, a whole worktree). Returns the live watcher —
/// hold it to keep watching, drop it to stop.
pub fn watch_dir(
    dir: &Path,
    on_event: impl Fn(&Event) + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                on_event(&event);
            }
        })
        .map_err(|e| e.to_string())?;
    watcher
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

/// A registry of live directory watchers keyed by a caller-chosen string.
/// Inserting under a key that already exists REPLACES (and thereby stops) the
/// prior watcher; removing stops it (the watcher drops). Thread-safe and
/// `Default` — designed to sit behind Tauri managed state, wrapped in a newtype
/// so distinct call sites (`HeadWatchers`, `ProjectFsWatchers`) get distinct
/// managed types.
#[derive(Default)]
pub struct WatchRegistry {
    inner: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatchRegistry {
    /// Register (or replace) the watcher under `key`.
    pub fn insert(&self, key: String, watcher: RecommendedWatcher) {
        self.lock().insert(key, watcher);
    }

    /// Stop and forget the watcher under `key`; an unknown key is a no-op.
    pub fn remove(&self, key: &str) {
        self.lock().remove(key);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, RecommendedWatcher>> {
        self.inner.lock().expect("watch registry poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("keepdeck-fswatch-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn watch_dir_delivers_a_child_change() {
        let dir = temp_dir();
        let (tx, rx) = mpsc::channel::<()>();
        let _watcher = watch_dir(&dir, move |_event| {
            let _ = tx.send(());
        })
        .expect("watch");

        fs::write(dir.join("new.txt"), "hi").unwrap();

        rx.recv_timeout(Duration::from_secs(10))
            .expect("an fs event within 10s");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn registry_insert_then_remove_is_idempotent() {
        let dir = temp_dir();
        let registry = WatchRegistry::default();
        registry.insert("k".to_string(), watch_dir(&dir, |_| {}).unwrap());
        registry.remove("k");
        registry.remove("k"); // unknown key now — no panic
        fs::remove_dir_all(&dir).ok();
    }
}
