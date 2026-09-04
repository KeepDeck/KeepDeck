//! Fleet artifacts: workspace-scoped persistence + the localhost display
//! server. The store owns the disk FORMAT; the TS domain owns the rules'
//! canonical definitions; this module is their Rust home.
//!
//! The enable pair is the feature's whole lifecycle (B11): ON claims the
//! store root FIRST (the transitive protection for the display server's
//! port — a second instance fails at the claim and never binds), then
//! binds the server; OFF tears the server down FIRST (bye to open
//! pages — subscribers close before anything they observe changes
//! shape), then releases the claim.

mod claim;
mod render;
/// pub(crate): hosts the refresh asset and its server-side wrapper — the
/// cross-module contract the skills tier's bundled content pins against.
pub(crate) mod serve;
mod server;
mod store;
mod token;

use std::sync::Mutex;
use tauri::State;

pub use store::{ArtifactMeta, ArtifactsStore, DeleteOutcome};

/// The managed feature state: the store plus the optional live display
/// server. One managed type, one lifecycle.
pub struct ArtifactsState {
    store: ArtifactsStore,
    root: Mutex<Option<std::path::PathBuf>>,
    server: Mutex<Option<server::DisplayServer>>,
}

impl ArtifactsState {
    pub fn new() -> Self {
        Self {
            store: ArtifactsStore::default(),
            root: Mutex::new(None),
            server: Mutex::new(None),
        }
    }

    /// The claim probe: is the feature's backend on (root claimed)? Read
    /// by skills staging as its bundled-tier gate — content obeys the
    /// same gate as its tools. Read-only bool, nothing more (the toggle
    /// story lives in the artifacts lane).
    pub(crate) fn is_claimed(&self) -> bool {
        self.root.lock().expect("artifacts root poisoned").is_some()
    }
}

impl Default for ArtifactsState {
    fn default() -> Self {
        Self::new()
    }
}

/// The store root: `<keepdeck home>/artifacts`.
///
/// The home is the app's OWN ([`crate::paths`]), not Tauri's data dir.
/// That dir is derived from the bundle identifier and is therefore the
/// same folder for a debug build and the installed one, while the store
/// root's claim is exclusive — so the two flavors collided on it: a dev
/// build beside a running release could never take the claim, which left
/// the whole feature unreachable, and untestable, by construction. Every
/// other path this app persists to already honors the per-flavor home;
/// this was the one that did not.
/// A store left by a pre-home install is adopted by [`crate::migration`],
/// which owns that whole story for every kind of legacy state — including
/// the rule that only a release build without a `KEEPDECK_HOME` override
/// may carry it off. Nothing about it belongs here.
fn store_root() -> Result<std::path::PathBuf, String> {
    crate::paths::keepdeck_home()
        .map(|home| home.join("artifacts"))
        .ok_or_else(|| "no KeepDeck home to hold the artifact store".to_string())
}

/// Now, in unix milliseconds — versions carry `at` stamps.
fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Open a URL in the system browser without an AppHandle (the publish
/// tail runs off the command's app context; the OS opener is the same
/// one the open_url command reaches). Best-effort by contract — callers
/// log, never fail. Scoped: `open` is the DARWIN opener — swap for
/// xdg-open if a Linux build ever lands.
fn open_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("spawning the opener failed: {e}"))
}

/// Claim the store root, then bind the display server on it.
/// Idempotent; a contention refusal surfaces verbatim so the toggle can
/// say WHY. Resolves to the display server's port.
fn enable_at(
    state: &ArtifactsState,
    root: &std::path::Path,
    start: impl FnOnce(&std::path::Path) -> Result<server::DisplayServer, String>,
) -> Result<u16, String> {
    // Root then server is the lifecycle lock order. Keeping both locks across
    // claim + bind makes a concurrent enable unable to observe a claim that a
    // failed bind is about to roll back.
    let mut bound = state.root.lock().expect("artifacts root poisoned");
    let mut server = state.server.lock().expect("artifacts server poisoned");
    if let Some(live) = server.as_ref() {
        if live.is_alive() {
            return Ok(live.port());
        }
        // The accept loop died on its own and dropped its listener: that
        // port answers nothing. Returning it would report success for a
        // server that is gone — the toggle reads On, every page gets a
        // refused connection, and the only trace is one log line. Bury it
        // and bind again; the claim is this process's and stays held.
        log::warn!("artifacts: display server had died — rebinding");
        if let Some(dead) = server.take() {
            dead.stop();
        }
    }

    let claimed_here = bound.is_none();
    if claimed_here {
        state.store.enable(root)?;
        *bound = Some(root.to_path_buf());
    }

    let started = match start(root) {
        Ok(started) => started,
        Err(error) => {
            if claimed_here {
                state.store.disable();
                *bound = None;
            }
            return Err(error);
        }
    };
    let port = started.port();
    *server = Some(started);
    log::info!(
        "artifacts: store claimed at {} — display on port {port}",
        root.display()
    );
    Ok(port)
}

#[tauri::command(async)]
pub fn artifacts_enable(state: State<ArtifactsState>) -> Result<u16, String> {
    let root = store_root()?;
    enable_at(&state, &root, server::DisplayServer::start)
}

/// Server teardown first (bye), then release the claim. Idempotent.
#[tauri::command(async)]
pub fn artifacts_disable(state: State<ArtifactsState>) {
    // Match enable_at's root-then-server order so a concurrent On cannot
    // bind a new server between teardown and root release.
    let mut bound = state.root.lock().expect("artifacts root poisoned");
    let mut server = state.server.lock().expect("artifacts server poisoned");
    if let Some(live) = server.take() {
        live.stop();
    }
    state.store.disable();
    *bound = None;
    log::info!("artifacts: display down, store released");
}

// ---- the artifact_* commands over the store ----
//
// The WORKSPACE is host fact, resolved TS-side from the command source
// and passed in the payload — never an agent-supplied argument (the §6
// verdict). Who published is not recorded at all: a pane's label is its
// live title, so what a version kept was a snapshot of a moving string,
// and nothing needs the answer. `cwd` rides the same payload as
// `Option<String>`: the
// three-rung ladder's rung 2 (provisioning pane) publishes `content`
// with no boundary.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPayload {
    workspace_id: String,
    cwd: Option<String>,
    slug: Option<String>,
    title: String,
    format: String,
    path: Option<String>,
    content: Option<String>,
    message: Option<String>,
    /// The auto-open flag (from the artifactAutoOpen setting): first
    /// publish of a NEW artifact opens the browser when true.
    auto_open: bool,
}

/// The TS-visible publish result: composed URLs, never the raw token
/// (B10's rule — a TS-visible token recreates the URL-assembly drift
/// site). `urls: null` while the display server is down: a publish must
/// never fail because the display was.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    slug: String,
    version: u64,
    is_new: bool,
    url: Option<String>,
    index_url: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePayload {
    workspace_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPayload {
    workspace_id: String,
    slug: String,
    version: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePayload {
    workspace_id: String,
    slug: String,
    /// Which incarnation of the slug the caller means. Present when a
    /// human was ASKED about a row and is now answering; absent for an
    /// agent, whose delete is an instruction about a name.
    expected_generation: Option<String>,
}

/// The notification router's identifier-only URL entry (B10): no token
/// in hand — the server resolves it. Dead artifact → artifact: null (the
/// router falls back to the index).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveUrlsResult {
    url: Option<String>,
    index_url: String,
}

#[tauri::command(async)]
pub fn artifact_publish(
    state: State<ArtifactsState>,
    payload: PublishPayload,
) -> Result<PublishResult, String> {
    use store::{ArtifactFormat, PublishRequest};
    // The door states what it accepts, and there is one thing: "md" is
    // refused here like any other word, because an artifact IS an html
    // page and no second renderer exists behind this call.
    let format = match payload.format.as_str() {
        "html" => ArtifactFormat::Html,
        other => {
            return Err(format!(
                "unknown format {other:?} — artifacts are html pages"
            ))
        }
    };
    let content = payload.content.as_deref().map(str::as_bytes);
    let request = PublishRequest {
        slug: payload.slug.as_deref(),
        title: &payload.title,
        format,
        path: payload.path.as_deref(),
        content,
        message: payload.message.as_deref(),
        cwd: payload.cwd.as_deref(),
    };
    let out = state
        .store
        .publish(&payload.workspace_id, request, unix_time_ms())
        .map_err(|e| e.0)?;
    // The display tail — everything here runs AFTER the store's data
    // mutex released (publish returned): compose URLs (null when the
    // server is down, honestly — a publish never fails on that), then
    // broadcast, then AUTO-OPEN on first-publish-of-NEW (best-effort:
    // an opener failure degrades to the notification that exists
    // anyway, logged, never failing the publish).
    //
    // The server LOCK is held only for the existence check + compose;
    // broadcast runs on the CLONED Arc — a wedged subscriber inside
    // broadcast_version must not hold every later publish tail (and the
    // enable/disable toggle) hostage behind this mutex.
    let url_and_index = {
        let server = state.server.lock().expect("artifacts server poisoned");
        server.as_ref().map(|live| {
            let (url, index) = live.compose_urls(&payload.workspace_id, &out.slug, &out.token);
            (url, index, live.shared_arc())
        })
    };
    let (url, index_url) = match url_and_index {
        Some((url, index, shared)) => {
            server::broadcast_version_on(&shared, &payload.workspace_id, &out.slug, out.version);
            if out.is_new && payload.auto_open {
                // Auto-open runs OUTSIDE every lock (the opener can
                // block on the OS).
                if let Err(e) = open_browser(&url) {
                    log::warn!("artifacts: auto-open failed (publish unaffected): {e}");
                }
            }
            (Some(url), Some(index))
        }
        None => (None, None),
    };
    Ok(PublishResult {
        slug: out.slug,
        version: out.version,
        is_new: out.is_new,
        url,
        index_url,
    })
}

/// One version as a surface shows it — the manifest's own shape.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionRow {
    n: u64,
    at: u64,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// One artifact, named. Its own type rather than a borrowed `ReadPayload`:
/// that one carries a `version`, and a command that silently ignores a
/// field its payload declares is a command whose caller cannot tell what
/// it was asked.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPayload {
    workspace_id: String,
    slug: String,
}

#[tauri::command(async)]
pub fn artifact_versions(
    state: State<ArtifactsState>,
    payload: ArtifactPayload,
) -> Result<Vec<VersionRow>, String> {
    let versions = state
        .store
        .versions(&payload.workspace_id, &payload.slug)
        .map_err(|e| e.0)?;
    Ok(versions
        .into_iter()
        .map(|v| VersionRow {
            n: v.n,
            at: v.at,
            size: v.size,
            message: v.message,
        })
        .collect())
}

#[tauri::command(async)]
pub fn artifact_list(
    state: State<ArtifactsState>,
    payload: WorkspacePayload,
) -> Result<Vec<ArtifactMeta>, String> {
    state.store.list(&payload.workspace_id).map_err(|e| e.0)
}

/// The read result, typed on the wire like every other artifact result
/// (camelCase keys by serde, not hand-written json! literals — a typo'd
/// key now fails compilation instead of shipping a dead field the TS
/// side silently ignores). Tagged by `kind`; the over-cap arm carries
/// the size and the honest note instead of the content.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum ReadOutcome {
    #[serde(rename_all = "camelCase")]
    Inline {
        id: String,
        version: u64,
        title: String,
        format: store::ArtifactFormat,
        content: String,
        at: u64,
    },
    #[serde(rename_all = "camelCase")]
    OverCap {
        id: String,
        version: u64,
        size: u64,
        title: String,
        note: String,
    },
}

#[tauri::command(async)]
pub fn artifact_read(
    state: State<ArtifactsState>,
    payload: ReadPayload,
) -> Result<ReadOutcome, String> {
    use store::ReadResult;
    let result = state
        .store
        .read(&payload.workspace_id, &payload.slug, payload.version)
        .map_err(|e| e.0)?;
    Ok(match result {
        ReadResult::Inline {
            slug,
            version,
            title,
            format,
            bytes,
            at,
        } => ReadOutcome::Inline {
            id: slug,
            version,
            title,
            format,
            content: String::from_utf8_lossy(&bytes).into_owned(),
            at,
        },
        ReadResult::OverCap { slug, version, size, title, note, .. } => ReadOutcome::OverCap {
            id: slug,
            version,
            size,
            title,
            note,
        },
    })
}

#[tauri::command(async)]
pub fn artifact_delete(
    state: State<ArtifactsState>,
    payload: DeletePayload,
) -> Result<DeleteOutcome, String> {
    let out = state
        .store
        .delete(
            &payload.workspace_id,
            &payload.slug,
            payload.expected_generation.as_deref(),
        )
        .map_err(|e| e.0)?;
    if out.deleted {
        let server = state.server.lock().expect("artifacts server poisoned");
        if let Some(live) = server.as_ref() {
            live.broadcast_bye(&payload.workspace_id, &payload.slug, "artifact deleted");
        }
    }
    Ok(out)
}

/// The notification router's URL resolution (identifier-only, B10).
/// Runs WITHOUT the server mutex (only the Arc): a notification click
/// must not queue behind a wedged publish tail's broadcast.
#[tauri::command(async)]
pub fn artifact_resolve_urls(
    state: State<ArtifactsState>,
    payload: WorkspacePayload,
    slug: String,
) -> Result<ResolveUrlsResult, String> {
    let shared = {
        let server = state.server.lock().expect("artifacts server poisoned");
        server.as_ref().map(|live| live.shared_arc())
    };
    match shared {
        Some(shared) => {
            let artifact = store::manifest_for(&shared.root, &payload.workspace_id, &slug)
                .ok()
                .flatten()
                .map(|m| server::artifact_url_for(&shared, &m.token, &slug));
            let index_url = server::index_url_for(&shared, &payload.workspace_id);
            Ok(ResolveUrlsResult { url: artifact, index_url })
        }
        None => Err("display server off".into()),
    }
}

/// Workspace deletion's hook: drop that workspace's whole artifact
/// store. Idempotent on absence; failure surfaces to the caller (the TS
/// side logs and continues — the deck teardown must not abort).
#[tauri::command(async)]
pub fn artifact_drop_workspace(
    state: State<ArtifactsState>,
    ws_id: String,
) -> Result<(), String> {
    state.store.drop_workspace(&ws_id).map_err(|e| e.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A display server that died on its own must never be reported as
    /// live. The accept loop self-destructs on a poll fault or on
    /// ACCEPT_FAILURE_LIMIT consecutive accept failures — it sets the
    /// dead flag and drops its listener, so the port answers nothing —
    /// and nothing restarts it. `stop()` leaves the same state, which is
    /// what makes it usable to stage the condition here.
    #[test]
    fn enable_rebinds_a_display_server_that_died_on_its_own() {
        let state = ArtifactsState::new();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("artifacts");

        let first = enable_at(&state, &root, server::DisplayServer::start).expect("first enable");
        {
            let server = state.server.lock().expect("server lock");
            server.as_ref().expect("a live server").stop();
        }

        let second = enable_at(&state, &root, server::DisplayServer::start).expect("re-enable");
        assert_ne!(
            first, second,
            "a dead server's port must not be handed back as if it served",
        );
        assert!(state
            .server
            .lock()
            .expect("server lock")
            .as_ref()
            .expect("a fresh server")
            .is_alive());

        if let Some(live) = state.server.lock().expect("server lock").take() {
            live.stop();
        }
        state.store.disable();
    }

    #[test]
    fn a_failed_display_server_start_rolls_back_the_claim_and_root() {
        let state = ArtifactsState::new();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("artifacts");

        let error = enable_at(&state, &root, |_| Err("injected display failure".into()))
            .expect_err("injected start must fail");

        assert_eq!(error, "injected display failure");
        assert!(!state.is_claimed());
        assert!(state.root.lock().expect("root lock").is_none());
        assert!(state.server.lock().expect("server lock").is_none());
        // The claim guard was released too: a subsequent owner can claim the
        // same root instead of inheriting the failed enable's lock.
        state.store.enable(&root).expect("claim after rollback");
        state.store.disable();
    }

}
