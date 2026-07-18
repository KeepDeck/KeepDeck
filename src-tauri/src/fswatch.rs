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
    watch(dir, RecursiveMode::NonRecursive, on_event)
}

/// Watch `dir` and its WHOLE subtree. The recursive variant exists for the one
/// consumer that genuinely means "anything in this tree" — a git working tree
/// whose status must follow edits landing anywhere inside it. On macOS this is
/// a single FSEvents stream per root (the OS walks the tree, not us), so depth
/// costs nothing; the caller still filters kinds/paths and MUST debounce, since
/// a build or checkout can fire thousands of events in a burst.
pub fn watch_dir_recursive(
    dir: &Path,
    on_event: impl Fn(&Event) + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    watch(dir, RecursiveMode::Recursive, on_event)
}

fn watch(
    dir: &Path,
    mode: RecursiveMode,
    on_event: impl Fn(&Event) + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                on_event(&event);
            }
        })
        .map_err(|e| e.to_string())?;
    watcher.watch(dir, mode).map_err(|e| e.to_string())?;
    Ok(watcher)
}

/// A registry of live watchers keyed by a caller-chosen string. Inserting
/// under a key that already exists REPLACES (and thereby stops) the prior
/// watcher; removing stops it (the watcher drops). Thread-safe and
/// `Default` — designed to sit behind Tauri managed state, wrapped in a
/// newtype so distinct call sites (`HeadWatchers`, `ProjectFsWatchers`,
/// `UsageTails`) get distinct managed types. Generic over the watcher kind
/// so the polling family shares it too.
pub struct WatchRegistry<W = RecommendedWatcher> {
    inner: Mutex<HashMap<String, W>>,
}

// Manual, not derived: a derive would demand `W: Default`, and watchers
// have no Default — an empty registry needs none.
impl<W> Default for WatchRegistry<W> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl<W> WatchRegistry<W> {
    /// Register (or replace) the watcher under `key`.
    pub fn insert(&self, key: String, watcher: W) {
        self.lock().insert(key, watcher);
    }

    /// Stop and forget the watcher under `key`; an unknown key is a no-op.
    pub fn remove(&self, key: &str) {
        self.lock().remove(key);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, W>> {
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
    fn watch_dir_recursive_sees_a_nested_change() {
        let dir = temp_dir();
        let nested = dir.join("a/b/c");
        fs::create_dir_all(&nested).unwrap();

        let (tx, rx) = mpsc::channel::<PathBuf>();
        let _watcher = watch_dir_recursive(&dir, move |event| {
            for p in &event.paths {
                let _ = tx.send(p.clone());
            }
        })
        .expect("watch");

        fs::write(nested.join("deep.txt"), "hi").unwrap();

        // The non-recursive sibling would never report a grandchild.
        let mut seen = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("an fs event within 10s");
        while !seen.ends_with("deep.txt") {
            seen = rx
                .recv_timeout(Duration::from_secs(5))
                .expect("the nested file's event");
        }
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
