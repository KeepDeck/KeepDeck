//! Fleet artifacts: workspace-scoped persistence + the localhost display
//! server (slice 5). The store owns the disk FORMAT; the TS domain owns
//! the rules' canonical definitions; this module is their Rust home.
//!
//! The enable pair is the feature's whole lifecycle: ON claims the store
//! root first (the transitive protection for the display server's port —
//! a second instance fails at the claim and never binds), then starts
//! the server (slice 5 attaches it here); OFF tears the server down first
//! (bye to open pages — subscribers close before anything they observe
//! changes shape), then releases the claim.

mod claim;
mod store;

use tauri::State;

/// Slice 4's command surface — unused until those commands register
/// (slices land in order), hence the allow.
#[allow(unused_imports)]
pub use store::{
    ArtifactFormat, ArtifactMeta, DeleteOutcome, PublishIdentity,
    PublishOutcome, PublishRequest, ReadResult, StoreError,
};
pub use store::ArtifactsStore;

/// The store root under the app's data dir (`<home>/artifacts`).
fn store_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("artifacts"))
        .map_err(|e| format!("resolving the data dir failed: {e}"))
}

/// Claim the store root (and, from slice 5, start the display server on
/// it). Idempotent; a contention refusal surfaces verbatim so the toggle
/// can say WHY. Resolves to the display port once slice 5 exists — 0 for
/// now, honestly, rather than a pretend port.
#[tauri::command(async)]
pub fn artifacts_enable(
    app: tauri::AppHandle,
    store: State<ArtifactsStore>,
) -> Result<u16, String> {
    let root = store_root(&app)?;
    store.enable(&root)?;
    log::info!("artifacts: store claimed at {}", root.display());
    Ok(0)
}

/// Tear down (server first from slice 5, then the claim). Idempotent.
#[tauri::command(async)]
pub fn artifacts_disable(store: State<ArtifactsStore>) {
    store.disable();
    log::info!("artifacts: store released");
}
