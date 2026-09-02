//! One-time adoption of the legacy state layout.
//!
//! Deck state used to live in Tauri's identifier-keyed dirs (on macOS
//! `~/Library/Application Support/ai.keepdeck.desktop`), shared by every
//! build flavor; it now lives in the keepdeck home (see `crate::paths`).
//! On launch this moves whatever a legacy install left behind: `deck.json`
//! (and its `.bak` quarantine) is copied into the home and the original
//! renamed `*.migrated` — retired rather than deleted, but invisible to a
//! legacy binary, so wiping the home can never resurrect an ancient deck.
//! The legacy session spool is simply removed: postbacks are ephemeral.
//! The artifact store — a whole tree, not a document — is MOVED, and only
//! into an empty seat.
//!
//! Only a release build without `KEEPDECK_HOME` migrates — the shared legacy
//! deck is the user's real one and belongs to the release home; a debug
//! build must never carry it off to `keepdeck-dev`.
//!
//! Best-effort throughout: migration never blocks startup, and a failed copy
//! leaves the original in place for the next launch. The whole module is
//! deletable once legacy installs are gone.

use std::fs;
use std::path::Path;
use tauri::Manager as _;

/// Migrate if this build owns the release home. Called once at setup, before
/// the webview boots and asks for the deck.
pub fn run(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) || std::env::var_os("KEEPDECK_HOME").is_some() {
        return;
    }
    let Some(home) = crate::paths::keepdeck_home() else {
        return;
    };
    let (Ok(old_config), Ok(old_data)) = (app.path().app_config_dir(), app.path().app_data_dir())
    else {
        return;
    };
    let summary = migrate(&old_config, &old_data, &home);
    if summary.any() {
        log::info!("legacy state migrated: {summary:?}");
    }
}

/// What one launch's migration actually did.
#[derive(Debug, Default, PartialEq, Eq)]
struct Summary {
    deck_adopted: bool,
    bak_adopted: bool,
    spool_removed: bool,
    artifacts_adopted: bool,
}

impl Summary {
    fn any(&self) -> bool {
        self.deck_adopted || self.bak_adopted || self.spool_removed || self.artifacts_adopted
    }
}

/// Move the legacy files under `home`. Idempotent: after the first pass the
/// originals are retired, so every later launch is a no-op.
fn migrate(old_config: &Path, old_data: &Path, home: &Path) -> Summary {
    Summary {
        deck_adopted: adopt(&old_config.join("deck.json"), &home.join("deck.json")),
        bak_adopted: adopt(&old_config.join("deck.json.bak"), &home.join("deck.json.bak")),
        spool_removed: fs::remove_dir_all(old_data.join("session-spool")).is_ok(),
        artifacts_adopted: adopt_tree(&old_data.join("artifacts"), &home.join("artifacts")),
    }
}

/// Move a whole legacy TREE into the home, and only into an empty seat.
///
/// A move, not the copy-then-retire `adopt` does: a document is small
/// enough that leaving a retired twin behind buys discoverability
/// cheaply, while an artifact store is every version of every page a
/// fleet ever published — a second copy of it is a cost the user did not
/// ask for. An occupied seat leaves the legacy tree exactly where it is:
/// whatever already lives in the home is this build's, and an older tree
/// must never land on top of it.
fn adopt_tree(old: &Path, new: &Path) -> bool {
    if !old.exists() || new.exists() {
        return false;
    }
    if let Some(parent) = new.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    fs::rename(old, new).is_ok()
}

/// Copy `old` to `new` unless `new` already exists (the home's document
/// always wins), then retire `old` as `<name>.migrated`. The original is
/// only retired once `new` durably holds a document — a failed copy leaves
/// everything discoverable. Returns whether the home received the bytes.
fn adopt(old: &Path, new: &Path) -> bool {
    let Ok(bytes) = fs::read(old) else {
        return false; // nothing legacy, or unreadable — leave it alone
    };
    let adopted = !new.exists() && crate::state::write_atomic(new, &bytes).is_ok();
    if new.exists() {
        let mut name = old.file_name().unwrap_or_default().to_os_string();
        name.push(".migrated");
        let _ = fs::rename(old, old.with_file_name(name));
    }
    adopted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A unique legacy-dir/home pair per test (std-only; no tempfile
    /// dependency). Legacy config and data dirs coincide, as on macOS.
    fn dirs() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "kd-migration-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        (root.join("legacy"), root.join("home"))
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn nothing_legacy_is_a_no_op() {
        let (legacy, home) = dirs();
        assert_eq!(migrate(&legacy, &legacy, &home), Summary::default());
        assert!(!home.exists());
    }

    #[test]
    fn adopts_the_legacy_deck_and_retires_the_original() {
        let (legacy, home) = dirs();
        write(&legacy.join("deck.json"), r#"{"version":1}"#);

        let summary = migrate(&legacy, &legacy, &home);

        assert!(summary.deck_adopted);
        assert_eq!(
            fs::read_to_string(home.join("deck.json")).unwrap(),
            r#"{"version":1}"#
        );
        assert!(!legacy.join("deck.json").exists());
        assert!(legacy.join("deck.json.migrated").exists());
    }

    #[test]
    fn an_existing_home_deck_is_never_overwritten() {
        let (legacy, home) = dirs();
        write(&legacy.join("deck.json"), "legacy");
        write(&home.join("deck.json"), "current");

        let summary = migrate(&legacy, &legacy, &home);

        assert!(!summary.deck_adopted);
        assert_eq!(
            fs::read_to_string(home.join("deck.json")).unwrap(),
            "current"
        );
        // The legacy copy is still retired — the ambiguity is resolved once.
        assert!(legacy.join("deck.json.migrated").exists());
    }

    #[test]
    fn quarantined_bak_travels_along() {
        let (legacy, home) = dirs();
        write(&legacy.join("deck.json.bak"), "evidence");

        let summary = migrate(&legacy, &legacy, &home);

        assert!(summary.bak_adopted);
        assert_eq!(
            fs::read_to_string(home.join("deck.json.bak")).unwrap(),
            "evidence"
        );
        assert!(legacy.join("deck.json.bak.migrated").exists());
    }

    #[test]
    fn second_launch_is_a_no_op() {
        let (legacy, home) = dirs();
        write(&legacy.join("deck.json"), "doc");
        assert!(migrate(&legacy, &legacy, &home).deck_adopted);

        assert_eq!(migrate(&legacy, &legacy, &home), Summary::default());
        assert_eq!(fs::read_to_string(home.join("deck.json")).unwrap(), "doc");
    }

    #[test]
    fn the_artifact_store_travels_whole_and_only_into_an_empty_seat() {
        let (legacy, home) = dirs();
        write(&legacy.join("artifacts/ws/ws-1/auth-flow/manifest.json"), "{}");

        let summary = migrate(&legacy, &legacy, &home);

        assert!(summary.artifacts_adopted);
        assert_eq!(
            fs::read_to_string(home.join("artifacts/ws/ws-1/auth-flow/manifest.json")).unwrap(),
            "{}"
        );
        // Moved, not copied: no second store of every published page.
        assert!(!legacy.join("artifacts").exists());
    }

    #[test]
    fn a_store_already_in_the_home_is_never_landed_on() {
        // The home's store is THIS build's, claimed and served; an older
        // tree from a shared legacy dir must not replace it, and must not
        // be destroyed either.
        let (legacy, home) = dirs();
        write(&legacy.join("artifacts/ws/ws-1/old/manifest.json"), "old");
        write(&home.join("artifacts/ws/ws-1/current/manifest.json"), "current");

        let summary = migrate(&legacy, &legacy, &home);

        assert!(!summary.artifacts_adopted);
        assert!(legacy.join("artifacts/ws/ws-1/old/manifest.json").exists());
        assert_eq!(
            fs::read_to_string(home.join("artifacts/ws/ws-1/current/manifest.json")).unwrap(),
            "current"
        );
    }

    #[test]
    fn legacy_spool_is_deleted() {
        let (legacy, home) = dirs();
        write(&legacy.join("session-spool/postback.json"), "{}");

        let summary = migrate(&legacy, &legacy, &home);

        assert!(summary.spool_removed);
        assert!(!legacy.join("session-spool").exists());
    }
}
