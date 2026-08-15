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

/// Now, in unix milliseconds — versions carry `at` stamps.
fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

// ---- slice 4: the artifact_* commands over the store ----
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
    auto_open: bool,
}

/// The TS-visible publish result: composed URLs, never the raw token
/// (B10's rule — a TS-visible token recreates the URL-assembly drift
/// site). `urls: null` while the display server is down (slice 5
/// attaches it): a publish must never fail because the display was.
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

#[tauri::command(async)]
pub fn artifact_publish(
    store: State<ArtifactsStore>,
    payload: PublishPayload,
) -> Result<PublishResult, String> {
    let format = match payload.format.as_str() {
        "html" => ArtifactFormat::Html,
        "md" => ArtifactFormat::Md,
        other => {
            return Err(format!(
                "unknown format {other:?} — expected html or md"
            ))
        }
    };
    // Content rides the invoke as a JSON string; the bytes it names are
    // what the store caps. A non-UTF8 body cannot arrive through this
    // channel (JSON), which is the cap's honest scope.
    let content = payload.content.as_deref().map(str::as_bytes);
    let identity = PublishIdentity {
        workspace_id: payload.workspace_id,
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
    let now = unix_time_ms();
    let out = store.publish(&identity, request, now).map_err(|e| e.0)?;
    // compose_urls arrives with slice 5's server: for now both URLs are
    // honestly null and the skill teaches printing id + title.
    let _ = payload.auto_open;
    Ok(PublishResult {
        slug: out.slug,
        version: out.version,
        is_new: out.is_new,
        url: None,
        index_url: None,
    })
}

#[tauri::command(async)]
pub fn artifact_list(
    store: State<ArtifactsStore>,
    payload: WorkspacePayload,
) -> Result<Vec<ArtifactMeta>, String> {
    store.list(&payload.workspace_id).map_err(|e| e.0)
}

#[tauri::command(async)]
pub fn artifact_read(
    store: State<ArtifactsStore>,
    payload: ReadPayload,
) -> Result<serde_json::Value, String> {
    let result = store
        .read(&payload.workspace_id, &payload.slug, payload.version, unix_time_ms())
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
            "slug": slug,
            "version": version,
            "title": title,
            "format": match format { ArtifactFormat::Html => "html", ArtifactFormat::Md => "md" },
            "content": String::from_utf8_lossy(&bytes).into_owned(),
            "authorLabel": author_label,
            "at": at,
        }),
        ReadResult::OverCap { slug, version, size, title, note, .. } => serde_json::json!({
            "kind": "overCap",
            "slug": slug,
            "version": version,
            "size": size,
            "title": title,
            "note": note,
        }),
    })
}

#[tauri::command(async)]
pub fn artifact_delete(
    store: State<ArtifactsStore>,
    payload: DeletePayload,
) -> Result<DeleteOutcome, String> {
    store.delete(&payload.workspace_id, &payload.slug).map_err(|e| e.0)
}
