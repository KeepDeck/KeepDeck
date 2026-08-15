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
mod serve;
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
}

impl Default for ArtifactsState {
    fn default() -> Self {
        Self::new()
    }
}

/// The store root under the app's data dir (`<home>/artifacts`).
fn store_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("artifacts"))
        .map_err(|e| format!("resolving the data dir failed: {e}"))
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
#[tauri::command(async)]
pub fn artifacts_enable(
    app: tauri::AppHandle,
    state: State<ArtifactsState>,
) -> Result<u16, String> {
    let root = store_root(&app)?;
    {
        let mut bound = state.root.lock().expect("artifacts root poisoned");
        if bound.is_none() {
            state.store.enable(&root)?;
            *bound = Some(root.clone());
        }
    }
    let mut server = state.server.lock().expect("artifacts server poisoned");
    if server.is_none() {
        let started = server::DisplayServer::start(&root)?;
        let port = started.port();
        *server = Some(started);
        log::info!(
            "artifacts: store claimed at {} — display on port {port}",
            root.display()
        );
        Ok(port)
    } else {
        Ok(server.as_ref().map(|s| s.port()).unwrap_or(0))
    }
}

/// Server teardown first (bye), then release the claim. Idempotent.
#[tauri::command(async)]
pub fn artifacts_disable(state: State<ArtifactsState>) {
    {
        let mut server = state.server.lock().expect("artifacts server poisoned");
        if let Some(live) = server.take() {
            live.stop();
        }
    }
    state.store.disable();
    *state.root.lock().expect("artifacts root poisoned") = None;
    log::info!("artifacts: display down, store released");
}

// ---- the artifact_* commands over the store ----
//
// Identity is HOST FACT, resolved TS-side from the command source and
// passed in the payload — never an agent-supplied argument (the §6
// verdict). `cwd` rides the same payload as `Option<String>`: the
// three-rung ladder's rung 2 (provisioning pane) publishes `content`
// with no boundary.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPayload {
    workspace_id: String,
    pane_id: String,
    label: String,
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
    use store::{ArtifactFormat, PublishIdentity, PublishRequest};
    let format = match payload.format.as_str() {
        "html" => ArtifactFormat::Html,
        "md" => ArtifactFormat::Md,
        other => {
            return Err(format!(
                "unknown format {other:?} — expected html or md"
            ))
        }
    };
    let content = payload.content.as_deref().map(str::as_bytes);
    let identity = PublishIdentity {
        workspace_id: payload.workspace_id.clone(),
        pane_id: payload.pane_id,
        label: payload.label,
    };
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
        .publish(&identity, request, unix_time_ms())
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

#[tauri::command(async)]
pub fn artifact_list(
    state: State<ArtifactsState>,
    payload: WorkspacePayload,
) -> Result<Vec<ArtifactMeta>, String> {
    state.store.list(&payload.workspace_id).map_err(|e| e.0)
}

#[tauri::command(async)]
pub fn artifact_read(
    state: State<ArtifactsState>,
    payload: ReadPayload,
) -> Result<serde_json::Value, String> {
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
            author_label,
            at,
        } => serde_json::json!({
            "kind": "inline",
            "id": slug,
            "version": version,
            "title": title,
            "format": match format { store::ArtifactFormat::Html => "html", store::ArtifactFormat::Md => "md" },
            "content": String::from_utf8_lossy(&bytes).into_owned(),
            "authorLabel": author_label,
            "at": at,
        }),
        ReadResult::OverCap { slug, version, size, title, note, .. } => serde_json::json!({
            "kind": "overCap",
            "id": slug,
            "version": version,
            "size": size,
            "title": title,
            "note": note,
        }),
    })
}

#[tauri::command(async)]
pub fn artifact_delete(
    state: State<ArtifactsState>,
    payload: DeletePayload,
) -> Result<DeleteOutcome, String> {
    let out = state
        .store
        .delete(&payload.workspace_id, &payload.slug)
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
                .map(|m| {
                    format!("http://127.0.0.1:{}/a/{}/{}", shared.port, m.token, slug)
                });
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
