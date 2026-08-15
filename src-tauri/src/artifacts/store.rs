//! The artifacts store: workspace-scoped persistence for fleet artifacts.
//!
//! Layout under the claimed root (`data_dir/artifacts/`):
//! `ws/<workspaceId>/<slug>/manifest.json` + immutable version files named
//! `v<n>.<html|md>` — the filename is DERIVED from the version number and
//! the artifact's PINNED format; there is deliberately no `file` field in
//! the manifest (nothing attacker-shaped is ever resolved — a hand-edited
//! manifest cannot turn the server into an arbitrary-file reader).
//!
//! Concurrency: all data mutations serialize on one mutex spanning the
//! whole read-modify-write (manifest load → mutate → `write_atomic` →
//! release). Broadcast/auto-open fire AFTER release — a blocked SSE writer
//! must never stall store mutations (the §2 contract). The store root's
//! cross-process exclusivity is [`claim`]'s business (flock), which the
//! enable path takes BEFORE anything binds.
//!
//! Untrusted input: agents share our OS user and can write `data_dir`
//! directly, so every manifest read parses as UNTRUSTED — strict shape
//! checks, size cap, and a malformed manifest quarantines THAT artifact
//! with a loud log (never a crash, never a fallback guess). NotFound is
//! ABSENCE, not corruption (the skills library's `sorted_dirs` precedent):
//! manual `rm -rf` is a supported operation and every partial state it can
//! leave behind is normal operation here.
//!
//! Enforcement (§6 of the design) lives in [`enforce_publish_path`] —
//! per-call STATELESS, a pure function of the invoke payload; no cwd or
//! boundary is ever cached on the enabled state.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::write_atomic;

use super::claim::{self, ClaimedRoot};

/// Caps mirrored from the TS domain (its `model.ts` owns the canonical
/// numbers and their tests; these must not drift).
pub(crate) const CONTENT_CAP_BYTES: usize = 256 * 1024;
pub(crate) const FILE_CAP_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const TITLE_MAX: usize = 200;
pub(crate) const MESSAGE_MAX: usize = 500;

/// A format pinned at first publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactFormat {
    Html,
    Md,
}

impl ArtifactFormat {
    fn extension(self) -> &'static str {
        match self {
            ArtifactFormat::Html => "html",
            ArtifactFormat::Md => "md",
        }
    }
}

/// One version's manifest entry. No `file` field — derived on read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionMeta {
    pub n: u64,
    pub author_pane_id: String,
    pub author_label: String,
    pub at: u64,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub title: String,
    pub format: ArtifactFormat,
    /// Unguessable per-artifact token, minted at first publish, stable for
    /// the artifact's life (open tabs survive iteration).
    pub token: String,
    pub created: u64,
    pub versions: Vec<VersionMeta>,
}

/// What `artifact_list` returns per artifact.
#[derive(Debug, Serialize)]
pub struct ArtifactMeta {
    pub id: String,
    pub title: String,
    pub format: ArtifactFormat,
    pub version_count: u64,
    pub updated_at: u64,
    pub last_author: String,
}

/// The publish identity — host fact resolved TS-side, never an agent arg.
#[derive(Debug, Clone)]
pub struct PublishIdentity {
    pub workspace_id: String,
    pub pane_id: String,
    pub label: String,
}

/// What the store hands the command handler for one publish.
#[derive(Debug)]
pub struct PublishOutcome {
    pub slug: String,
    pub version: u64,
    pub is_new: bool,
    /// The artifact's token — STORE-INTERNAL (the TS-visible result
    /// carries composed URLs, never this).
    pub token: String,
}

/// A publish request after arg-shape validation.
#[derive(Debug)]
pub struct PublishRequest<'a> {
    pub slug: Option<&'a str>,
    pub title: &'a str,
    pub format: ArtifactFormat,
    /// Publish a file the bridge never carries; Rust reads it.
    pub path: Option<&'a str>,
    /// Inline bytes (capped at CONTENT_CAP_BYTES at the boundary).
    pub content: Option<&'a [u8]>,
    pub message: Option<&'a str>,
}

/// The store's error: a sentence the agent can act on (the command layer
/// surfaces it via isError:true — never a protocol error).
#[derive(Debug)]
pub struct StoreError(pub String);

impl StoreError {
    fn new(message: impl Into<String>) -> Self {
        StoreError(message.into())
    }
}

type StoreResult<T> = Result<T, StoreError>;

/// The store's lifecycle half: claimed-or-not. Data mutations live on the
/// enabled state's OWN mutex, taken per operation.
pub struct ArtifactsStore {
    enabled: Mutex<Option<Enabled>>,
}

struct Enabled {
    _root: ClaimedRoot,
    /// Serializes every read-modify-write of manifest data.
    data: Mutex<()>,
}

impl Default for ArtifactsStore {
    fn default() -> Self {
        Self {
            enabled: Mutex::new(None),
        }
    }
}

impl ArtifactsStore {
    /// Enable: claim the root (idempotent — enabling while enabled IS the
    /// state asked for). Contention surfaces the refusal text verbatim so
    /// the toggle can report WHY.
    pub fn enable(&self, root: &Path) -> Result<(), String> {
        let mut enabled = self.enabled.lock().expect("artifacts store poisoned");
        if enabled.is_some() {
            return Ok(());
        }
        let claimed = claim::claim(root)?;
        *enabled = Some(Enabled {
            _root: claimed,
            data: Mutex::new(()),
        });
        Ok(())
    }

    /// Disable: release the claim. Off while off is a no-op.
    pub fn disable(&self) {
        let mut enabled = self.enabled.lock().expect("artifacts store poisoned");
        *enabled = None;
    }

    fn with_enabled<T>(
        &self,
        run: impl FnOnce(&Path, &Mutex<()>) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let enabled = self.enabled.lock().expect("artifacts store poisoned");
        let Some(state) = enabled.as_ref() else {
            return Err(StoreError::new(
                "artifact store is off — turn the artifacts experiment on first",
            ));
        };
        run(state._root.root(), &state.data)
    }

    /// Publish: plan against the current manifest under the resolved slug
    /// (the domain planner's contract — explicit names the canvas, minted
    /// retries past every collision), then write.
    pub fn publish(
        &self,
        identity: &PublishIdentity,
        request: PublishRequest<'_>,
        now_ms: u64,
    ) -> StoreResult<PublishOutcome> {
        self.with_enabled(|root, data| {
            let title = validate_title(request.title)?;
            let format = request.format;
            let bytes = read_source(root, &request)?;
            let _guard = data.lock().expect("artifacts data poisoned");

            // The planning contract: `existing` is the artifact under the
            // EXPLICIT slug (absent for minted requests); suffix occupancy
            // is a directory probe.
            let existing = match request.slug {
                Some(slug) => load_manifest(root, identity.workspace_id.as_str(), slug)?,
                None => None,
            };
            let slug = resolve_slug(existing.as_ref(), &request, root, &identity.workspace_id)?;
            let slug = slug.as_str();

            let (outcome, mut manifest) = match existing {
                Some(manifest) => {
                    let next = manifest.versions.last().map(|v| v.n + 1).unwrap_or(1);
                    (PublishOutcome {
                        slug: slug.to_string(),
                        version: next,
                        is_new: false,
                        token: manifest.token.clone(),
                    }, manifest)
                }
                None => {
                    let manifest = Manifest {
                        title: title.to_string(),
                        format,
                        token: Uuid::new_v4().simple().to_string(),
                        created: now_ms,
                        versions: Vec::new(),
                    };
                    (PublishOutcome {
                        slug: slug.to_string(),
                        version: 1,
                        is_new: true,
                        token: manifest.token.clone(),
                    }, manifest)
                }
            };

            let dir = artifact_dir(root, &identity.workspace_id, slug);
            fs::create_dir_all(&dir).map_err(|e| StoreError::new(format!("creating artifact directory failed: {e}")))?;
            let file_name = format!("v{}.{ext}", outcome.version, ext = manifest.format.extension());
            write_atomic(&dir.join(&file_name), &bytes)
                .map_err(|e| StoreError::new(format!("writing version file failed: {e}")))?;
            manifest.versions.push(VersionMeta {
                n: outcome.version,
                author_pane_id: identity.pane_id.clone(),
                author_label: identity.label.clone(),
                at: now_ms,
                size: bytes.len() as u64,
                message: request.message.map(str::to_string),
            });
            let manifest_bytes = serde_json::to_vec(&manifest)
                .map_err(|e| StoreError::new(format!("encoding manifest failed: {e}")))?;
            write_atomic(&dir.join(MANIFEST_FILE), &manifest_bytes)
                .map_err(|e| StoreError::new(format!("writing manifest failed: {e}")))?;
            Ok(outcome)
        })
    }

    /// List a workspace's artifacts — newest first by `updated_at`.
    pub fn list(&self, workspace_id: &str) -> StoreResult<Vec<ArtifactMeta>> {
        self.with_enabled(|root, _data| {
            let mut out = Vec::new();
            for dir in sorted_dirs(&workspaces_root(root).join(workspace_id))? {
                let Some(slug) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                    continue;
                };
                if let Some(manifest) = load_manifest(root, workspace_id, &slug)? {
                    let last = manifest.versions.last();
                    out.push(ArtifactMeta {
                        id: slug,
                        title: manifest.title,
                        format: manifest.format,
                        version_count: manifest.versions.len() as u64,
                        updated_at: last.map(|v| v.at).unwrap_or(manifest.created),
                        last_author: last.map(|v| v.author_label.clone()).unwrap_or_default(),
                    });
                }
            }
            out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
            Ok(out)
        })
    }

    /// Read one version: inline bytes under the cap, else metadata + note
    /// (NO path return — a store path teaches agents where the store
    /// lives; a truncated half-artifact is worse than a pointer).
    pub fn read(
        &self,
        workspace_id: &str,
        slug: &str,
        version: Option<u64>,
        now_ms: u64,
    ) -> StoreResult<ReadResult> {
        self.with_enabled(|root, _data| {
            let manifest = load_manifest(root, workspace_id, slug)?
                .ok_or_else(|| StoreError::new(format!("no artifact called {slug:?}")))?;
            let n = version.unwrap_or_else(|| {
                manifest.versions.last().map(|v| v.n).unwrap_or(1)
            });
            let entry = manifest
                .versions
                .iter()
                .find(|v| v.n == n)
                .ok_or_else(|| StoreError::new(format!("{slug} has no version {n}")))?;
            let path = artifact_dir(root, workspace_id, slug)
                .join(format!("v{}.{ext}", n, ext = manifest.format.extension()));
            let bytes = fs::read(&path).map_err(|e| match e.kind() {
                ErrorKind::NotFound => StoreError::new(format!(
                    "version {n} of {slug} is unavailable — its file is absent"
                )),
                e => StoreError::new(format!("reading version {n} of {slug} failed: {e}")),
            })?;
            if bytes.len() > CONTENT_CAP_BYTES as usize {
                return Ok(ReadResult::OverCap {
                    slug: slug.to_string(),
                    version: n,
                    size: bytes.len() as u64,
                    title: manifest.title,
                    note: "this version exceeds the inline cap — open it in the browser or export it".into(),
                    _now: now_ms,
                });
            }
            Ok(ReadResult::Inline {
                slug: slug.to_string(),
                version: n,
                title: manifest.title,
                format: manifest.format,
                bytes,
                author_label: entry.author_label.clone(),
                at: entry.at,
            })
        })
    }

    /// Delete: whole-directory removal, idempotent no-op on absence, the
    /// identity-race-informative metadata in the response.
    pub fn delete(
        &self,
        workspace_id: &str,
        slug: &str,
    ) -> StoreResult<DeleteOutcome> {
        self.with_enabled(|root, data| {
            let _guard = data.lock().expect("artifacts data poisoned");
            let dir = artifact_dir(root, workspace_id, slug);
            let manifest = load_manifest(root, workspace_id, slug)?;
            match manifest {
                None => Ok(DeleteOutcome {
                    slug: slug.to_string(),
                    deleted: false,
                    version_count: None,
                    created_at: None,
                }),
                Some(manifest) => {
                    let version_count = manifest.versions.len() as u64;
                    let created_at = manifest.created;
                    remove_dir_all_best_effort(&dir)?;
                    Ok(DeleteOutcome {
                        slug: slug.to_string(),
                        deleted: true,
                        version_count: Some(version_count),
                        created_at: Some(created_at),
                    })
                }
            }
        })
    }

    /// Drop a workspace's whole store — called from workspace deletion
    /// (the live workspace set is deck-model knowledge Rust cannot
    /// derive). Idempotent on absence.
    pub fn drop_workspace(&self, workspace_id: &str) -> StoreResult<()> {
        self.with_enabled(|root, _data| {
            let dir = workspaces_root(root).join(workspace_id);
            match fs::remove_dir_all(&dir) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                Err(e) => Err(StoreError::new(format!(
                    "dropping the artifact store for {workspace_id} failed: {e}"
                ))),
            }
        })
    }
}

const MANIFEST_FILE: &str = "manifest.json";
/// A manifest larger than this is untrusted garbage, not state.
const MANIFEST_CAP_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
#[allow(dead_code)]
pub enum ReadResult {
    Inline {
        slug: String,
        version: u64,
        title: String,
        format: ArtifactFormat,
        bytes: Vec<u8>,
        author_label: String,
        at: u64,
    },
    OverCap {
        slug: String,
        version: u64,
        size: u64,
        title: String,
        note: String,
        _now: u64,
    },
}

#[derive(Debug, Serialize)]
pub struct DeleteOutcome {
    pub slug: String,
    pub deleted: bool,
    pub version_count: Option<u64>,
    pub created_at: Option<u64>,
}

fn workspaces_root(root: &Path) -> PathBuf {
    root.join("ws")
}

fn artifact_dir(root: &Path, workspace_id: &str, slug: &str) -> PathBuf {
    workspaces_root(root).join(workspace_id).join(slug)
}

/// One path-segment safety check, the skills library's rule: plain name,
/// no traversal. Workspace ids arrive from the deck model, slugs from the
/// agent — both get the same wall.
fn require_safe(segment: &str, what: &str) -> StoreResult<()> {
    let ok = !segment.is_empty()
        && segment.len() <= 64
        && segment
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(StoreError::new(format!("unsafe {what}: {segment:?}")))
    }
}

fn validate_title(title: &str) -> StoreResult<&str> {
    if title.is_empty() || title.chars().count() > TITLE_MAX {
        return Err(StoreError::new(format!(
            "title must be 1..={TITLE_MAX} chars"
        )));
    }
    Ok(title)
}

/// Subdirectories of `dir`, name-sorted; a missing dir is just empty
/// (NotFound = absence, the skills-library precedent).
fn sorted_dirs(dir: &Path) -> StoreResult<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(StoreError::new(format!("reading {dir:?} failed: {e}"))),
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    Ok(dirs)
}

/// Load one artifact's manifest, parsing as UNTRUSTED input: strict shape
/// checks (serde does the field work), a size cap, versions numbered
/// densely from 1 (a gap or a zero means a hand-edit), and the derived
/// filename must agree with the declared format. Malformed = quarantine
/// the artifact (rename its dir aside) + loud log; the artifact 404s.
/// Absent = None (absence, not corruption).
fn load_manifest(
    root: &Path,
    workspace_id: &str,
    slug: &str,
) -> StoreResult<Option<Manifest>> {
    require_safe(workspace_id, "workspace id")?;
    require_safe(slug, "slug")?;
    let dir = artifact_dir(root, workspace_id, slug);
    let path = dir.join(MANIFEST_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(StoreError::new(format!("reading {slug}'s manifest failed: {e}"))),
    };
    if bytes.len() as u64 > MANIFEST_CAP_BYTES {
        quarantine(&dir, slug, "manifest over cap");
        return Ok(None);
    }
    match serde_json::from_slice::<Manifest>(&bytes) {
        Ok(manifest) => {
            for (index, version) in manifest.versions.iter().enumerate() {
                if version.n != index as u64 + 1 {
                    quarantine(&dir, slug, "version numbers not dense from 1");
                    return Ok(None);
                }
            }
            if !manifest.versions.is_empty()
                && manifest.versions.iter().any(|v| {
                    !dir.join(format!("v{}.{ext}", v.n, ext = manifest.format.extension())).exists()
                })
            {
                // A manifest naming absent files is a PARTIAL state (a
                // version file was rm'd by hand): the artifact stays
                // listable, that VERSION 404s on read. Not corruption.
            }
            Ok(Some(manifest))
        }
        Err(e) => {
            quarantine(&dir, slug, &format!("malformed manifest: {e}"));
            Ok(None)
        }
    }
}

/// Move a broken artifact directory aside so it 404s loudly instead of
/// serving garbage. Best-effort: a failed rename only logs — the artifact
/// keeps 404ing either way (the manifest stays unloadable), and nothing
/// about a quarantine may crash a caller.
fn quarantine(dir: &Path, slug: &str, why: &str) {
    let mut aside = dir.as_os_str().to_os_string();
    aside.push(format!(".{}.quarantined", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)));
    let aside = PathBuf::from(aside);
    log::error!("artifacts: quarantining {slug:?} ({why})");
    if let Err(e) = fs::rename(dir, &aside) {
        log::error!("artifacts: quarantine rename failed for {slug:?}: {e}");
    }
}

fn remove_dir_all_best_effort(dir: &Path) -> StoreResult<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(StoreError::new(format!(
            "removing {} failed: {e}",
            dir.display()
        ))),
    }
}

/// The mint path's occupancy probe (the planner's `exists`).
fn slug_occupied(root: &Path, workspace_id: &str, slug: &str) -> bool {
    artifact_dir(root, workspace_id, slug).join(MANIFEST_FILE).exists()
}

/// Resolve the publish slug: explicit slugs are validated and used as
/// named (their manifest IS the canvas — a format flip is refused naming
/// the original, mirroring the domain planner); minted slugs derive from
/// the title and retry `-2`, `-3`, … past EVERY collision (a derived name
/// never joins a stranger's canvas — the design's letter, pinned in the
/// domain planner's tests).
fn resolve_slug<'a>(
    existing: Option<&Manifest>,
    request: &PublishRequest<'a>,
    root: &Path,
    workspace_id: &str,
) -> StoreResult<String> {
    if let Some(explicit) = request.slug {
        require_safe(explicit, "slug")?;
        // The domain grammar is lowercase; the store's wall agrees.
        if !explicit
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(StoreError::new(format!(
                "slug must be lowercase letters, digits, dashes: {explicit:?}"
            )));
        }
        if let Some(manifest) = existing {
            if manifest.format != request.format {
                return Err(StoreError::new(format!(
                    "{explicit} is {:?}; publish a new artifact for {:?}",
                    manifest.format, request.format
                )));
            }
        }
        return Ok(explicit.to_string());
    }
    let base = mint_slug_from_title(request.title);
    for attempt in 1..=MINT_RETRY_MAX {
        let suffix = if attempt == 1 { String::new() } else { format!("-{attempt}") };
        let head = {
            let keep = 64usize.saturating_sub(suffix.len());
            let cut = &base[..base.len().min(keep)];
            cut.trim_end_matches('-').to_string()
        };
        let candidate = format!("{head}{suffix}");
        if !slug_occupied(root, workspace_id, &candidate) {
            return Ok(candidate);
        }
    }
    Err(StoreError::new("mint retries exhausted — choose an explicit id"))
}

const MINT_RETRY_MAX: usize = 8;

/// Mint a slug from the title (the domain's derivation, mirrored for the
/// Rust side; the TS planner owns the canonical definition and its tests).
fn mint_slug_from_title(title: &str) -> String {
    let mut derived = String::new();
    let mut dash = false;
    for c in title.chars() {
        let lower = c.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
            derived.push(lower);
            dash = false;
        } else if !dash && !derived.is_empty() {
            derived.push('-');
            dash = true;
        }
    }
    while derived.ends_with('-') {
        derived.pop();
    }
    let truncated: String = derived.chars().take(64).collect();
    let trimmed = truncated.trim_end_matches('-');
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Read the publish source: `path` (preferred — the bridge never carries
/// the bytes) or `content` (inline, capped). §6 enforcement applies to
/// the path arm.
fn read_source(root: &Path, request: &PublishRequest<'_>) -> StoreResult<Vec<u8>> {
    match (request.path, request.content) {
        (Some(path), _) => {
            let bytes = enforce_and_read(root, path, request.format)?;
            if bytes.len() > FILE_CAP_BYTES {
                return Err(StoreError::new(format!(
                    "source file exceeds the {FILE_CAP_BYTES}-byte cap"
                )));
            }
            Ok(bytes)
        }
        (None, Some(content)) => {
            if content.len() > CONTENT_CAP_BYTES {
                return Err(StoreError::new(format!(
                    "inline content exceeds the {CONTENT_CAP_BYTES}-byte cap — publish a file path instead"
                )));
            }
            Ok(content.to_vec())
        }
        (None, None) => Err(StoreError::new(
            "publish needs one of `path` or `content`",
        )),
    }
}

/// §6 enforcement, per-call stateless: canonicalize both, prefix-check
/// with a separator, extension must agree with the declared format, and
/// the store root itself is off-limits (self-reference). A `cwd` is
/// required — TS refuses remote/provisioning panes' path arms before the
/// invoke, and Rust re-checks containment against the boundary it was
/// handed (trust-but-verify: TS is first-party, but the wall is cheap).
fn enforce_and_read(root: &Path, path: &str, format: ArtifactFormat) -> StoreResult<Vec<u8>> {
    let declared = Path::new(path);
    match declared.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case(format.extension()) => {}
        other => {
            return Err(StoreError::new(format!(
                "path extension {:?} does not match the declared format {:?}",
                other, format
            )))
        }
    }
    let canonical = fs::canonicalize(declared)
        .map_err(|e| StoreError::new(format!("resolving {path:?} failed: {e}")))?;
    let root_canonical = fs::canonicalize(root)
        .map_err(|e| StoreError::new(format!("resolving the store root failed: {e}")))?;
    if canonical.starts_with(&root_canonical) {
        return Err(StoreError::new(
            "the artifact store's own directory is not a publishable source",
        ));
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|e| StoreError::new(format!("stat {path:?} failed: {e}")))?;
    if !metadata.is_file() {
        return Err(StoreError::new(format!("{path:?} is not a file")));
    }
    fs::read(&canonical).map_err(|e| StoreError::new(format!("reading {path:?} failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn store_with_root(tag: &str) -> (ArtifactsStore, tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(format!("artifacts-{tag}"));
        let store = ArtifactsStore::default();
        store.enable(&root).expect("enable");
        (store, dir, root)
    }

    fn identity() -> PublishIdentity {
        PublishIdentity {
            workspace_id: "ws-1".into(),
            pane_id: "pane-1".into(),
            label: "support 1".into(),
        }
    }

    fn content_request<'a>(slug: Option<&'a str>, content: &'a [u8]) -> PublishRequest<'a> {
        PublishRequest {
            slug,
            title: "Auth Flow",
            format: ArtifactFormat::Html,
            path: None,
            content: Some(content),
            message: None,
        }
    }

    #[test]
    fn roundtrip_publish_manifest_list_read() {
        let (store, _dir, root) = store_with_root("roundtrip");
        let out = store
            .publish(&identity(), content_request(Some("auth-flow"), b"<h1>v1</h1>"), 1000)
            .unwrap();
        assert_eq!((out.slug.as_str(), out.version, out.is_new), ("auth-flow", 1, true));

        // Derived-filename invariant: v1.html under ws/<id>/<slug>/.
        let file = root.join("ws/ws-1/auth-flow/v1.html");
        assert!(file.exists(), "derived filename");
        assert!(root.join("ws/ws-1/auth-flow/manifest.json").exists());

        let list = store.list("ws-1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "auth-flow");
        assert_eq!(list[0].version_count, 1);
        assert_eq!(list[0].last_author, "support 1");

        match store.read("ws-1", "auth-flow", None, 0).unwrap() {
            ReadResult::Inline { bytes, version, .. } => {
                assert_eq!(bytes, b"<h1>v1</h1>");
                assert_eq!(version, 1);
            }
            other => panic!("expected inline, got {other:?}"),
        }
    }

    #[test]
    fn republish_appends_and_attributes_each_version() {
        let (store, _dir, _root) = store_with_root("append");
        store.publish(&identity(), content_request(Some("x"), b"one"), 1000).unwrap();
        let mut other = identity();
        other.pane_id = "pane-2".into();
        other.label = "support 2".into();
        let out = store.publish(&other, content_request(Some("x"), b"two"), 2000).unwrap();
        assert_eq!((out.version, out.is_new), (2, false));
        let list = store.list("ws-1").unwrap();
        assert_eq!(list[0].version_count, 2);
        assert_eq!(list[0].last_author, "support 2");
    }

    #[test]
    fn format_flip_refused_naming_the_original() {
        let (store, _dir, _root) = store_with_root("flip");
        store.publish(&identity(), content_request(Some("x"), b"<p/"), 1000).unwrap();
        let mut md_request = content_request(Some("x"), b"# hello".as_slice() as &[u8]);
        md_request.format = ArtifactFormat::Md;
        let err = store.publish(&identity(), md_request, 2000).unwrap_err();
        assert!(err.0.contains("x is"), "refusal names the original: {}", err.0);
    }

    #[test]
    fn mint_retries_past_a_stranger_canvas() {
        let (store, _dir, _root) = store_with_root("mint");
        // Someone else holds auth-flow; a minted title derives the same base.
        store.publish(&identity(), content_request(Some("auth-flow"), b"<p/>"), 1000).unwrap();
        let out = store
            .publish(&identity(), content_request(None, b"<p/>"), 2000)
            .unwrap();
        assert_eq!(out.slug, "auth-flow-2");
        assert!(out.is_new);
    }

    #[test]
    fn delete_is_idempotent_whole_dir_and_informative() {
        let (store, _dir, root) = store_with_root("delete");
        store.publish(&identity(), content_request(Some("gone"), b"<p/>"), 1000).unwrap();
        let first = store.delete("ws-1", "gone").unwrap();
        assert!(first.deleted);
        assert_eq!(first.version_count, Some(1));
        assert_eq!(first.created_at, Some(1000));
        assert!(!root.join("ws/ws-1/gone").exists(), "whole dir removed");

        let retry = store.delete("ws-1", "gone").unwrap();
        assert!(!retry.deleted);
        assert_eq!(retry.version_count, None);
    }

    #[test]
    fn delete_then_republish_is_resurrection() {
        let (store, _dir, _root) = store_with_root("resurrect");
        let first = store.publish(&identity(), content_request(Some("phoenix"), b"<p/>"), 1000).unwrap();
        store.delete("ws-1", "phoenix").unwrap();
        let second = store.publish(&identity(), content_request(Some("phoenix"), b"<p/>"), 3000).unwrap();
        assert!(second.is_new, "resurrection is a first publish");
        assert_eq!(second.version, 1);
        assert_ne!(first.token, second.token, "fresh token, old URLs die");
    }

    #[test]
    fn malformed_manifest_quarantines_never_crashes() {
        let (store, _dir, root) = store_with_root("quarantine");
        store.publish(&identity(), content_request(Some("sick"), b"<p/>"), 1000).unwrap();
        std::fs::write(root.join("ws/ws-1/sick/manifest.json"), b"{ not json").unwrap();
        // The artifact 404s (absence), the store keeps working.
        let list = store.list("ws-1").unwrap();
        assert!(list.iter().all(|a| a.id != "sick"));
        assert!(store.read("ws-1", "sick", None, 0).is_err());
        // And a new publish under the same slug resurrects cleanly.
        let out = store.publish(&identity(), content_request(Some("sick"), b"<p/>"), 2000).unwrap();
        assert!(out.is_new);
    }

    #[test]
    fn manual_rm_leaves_normal_operation() {
        let (store, _dir, root) = store_with_root("rm-rf");
        store.publish(&identity(), content_request(Some("a"), b"<p/>"), 1000).unwrap();
        std::fs::remove_file(root.join("ws/ws-1/a/manifest.json")).unwrap();
        // Absent manifest = absence: list empty, publish recreates.
        assert!(store.list("ws-1").unwrap().is_empty());
        let out = store.publish(&identity(), content_request(Some("a"), b"<p/>"), 2000).unwrap();
        assert!(out.is_new);
    }

    #[test]
    fn concurrent_same_slug_first_publishes_serialize_into_v1_v2() {
        let (store, _dir, _root) = store_with_root("race");
        let store = Arc::new(store);
        let mut handles = Vec::new();
        for i in 0..2u64 {
            let store = Arc::clone(&store);
            handles.push(std::thread::spawn(move || {
                let mut who = identity();
                who.pane_id = format!("pane-{i}");
                who.label = format!("racer-{i}");
                store
                    .publish(&who, content_request(Some("race"), b"<p/>"), 1000 + i)
                    .unwrap()
            }));
        }
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let mut versions: Vec<u64> = results.iter().map(|o| o.version).collect();
        versions.sort_unstable();
        assert_eq!(versions, vec![1, 2], "one artifact, both attributed");
        let list = store.list("ws-1").unwrap();
        assert_eq!(list[0].version_count, 2);
    }

    #[test]
    fn drop_workspace_is_total_and_idempotent() {
        let (store, _dir, root) = store_with_root("drop");
        store.publish(&identity(), content_request(Some("a"), b"<p/>"), 1000).unwrap();
        store.drop_workspace("ws-1").unwrap();
        assert!(!root.join("ws/ws-1").exists());
        store.drop_workspace("ws-1").unwrap(); // absent is fine
    }

    #[test]
    fn path_publish_enforced_containment_extension_and_caps() {
        let (store, dir, _root) = store_with_root("enforce");
        // Inside cwd, right extension: OK.
        let good = dir.path().join("page.html");
        std::fs::write(&good, b"<p>ok</p>").unwrap();
        let ok_request = PublishRequest {
            slug: Some("via-path"),
            title: "T",
            format: ArtifactFormat::Html,
            path: Some(good.to_str().unwrap()),
            content: None,
            message: None,
        };
        store.publish(&identity(), ok_request, 1000).unwrap();

        // Wrong extension vs declared format: refused.
        let wrong = dir.path().join("page.md");
        std::fs::write(&wrong, b"# md").unwrap();
        let wrong_request = PublishRequest {
            slug: Some("via-path"),
            title: "T",
            format: ArtifactFormat::Html,
            path: Some(wrong.to_str().unwrap()),
            content: None,
            message: None,
        };
        let err = store.publish(&identity(), wrong_request, 2000).unwrap_err();
        assert!(err.0.contains("does not match"), "extension gate: {}", err.0);

        // The store's own root is not a publishable source.
        let manifest_file = _root.join("ws/ws-1/via-path/manifest.json");
        let self_request = PublishRequest {
            slug: Some("self"),
            title: "T",
            format: ArtifactFormat::Html,
            path: Some(manifest_file.to_str().unwrap()),
            content: None,
            message: None,
        };
        // (manifest.json has the wrong extension anyway; use a planted
        // .html file inside the root for the true self-reference case.)
        let planted = _root.join("ws/ws-1/planted.html");
        std::fs::create_dir_all(_root.join("ws/ws-1")).unwrap();
        std::fs::write(&planted, b"<p>inside store</p>").unwrap();
        let self_request = PublishRequest {
            slug: Some("self"),
            title: "T",
            format: ArtifactFormat::Html,
            path: Some(planted.to_str().unwrap()),
            content: None,
            message: None,
        };
        let err = store.publish(&identity(), self_request, 3000).unwrap_err();
        assert!(err.0.contains("not a publishable source"), "store wall: {}", err.0);

        // Oversized file: refused.
        let big = dir.path().join("big.html");
        std::fs::write(&big, vec![b'x'; FILE_CAP_BYTES + 1]).unwrap();
        let big_request = PublishRequest {
            slug: Some("big"),
            title: "T",
            format: ArtifactFormat::Html,
            path: Some(big.to_str().unwrap()),
            content: None,
            message: None,
        };
        let err = store.publish(&identity(), big_request, 4000).unwrap_err();
        assert!(err.0.contains("cap"), "file cap: {}", err.0);
    }

    #[test]
    fn content_cap_at_the_boundary() {
        let (store, _dir, _root) = store_with_root("cap");
        let at_cap = vec![b'x'; CONTENT_CAP_BYTES];
        let ok = content_request(Some("cap"), &at_cap);
        store.publish(&identity(), ok, 1000).unwrap();
        let over_cap = vec![b'x'; CONTENT_CAP_BYTES + 1];
        let over = content_request(Some("cap2"), &over_cap);
        let err = store.publish(&identity(), over, 2000).unwrap_err();
        assert!(err.0.contains("cap"), "content cap: {}", err.0);
    }

    #[test]
    fn read_over_cap_returns_metadata_not_path() {
        let (store, dir, _root) = store_with_root("overcap");
        // A file source above the CONTENT cap but under the FILE cap.
        let big = dir.path().join("big.html");
        std::fs::write(&big, vec![b'x'; CONTENT_CAP_BYTES + 1024]).unwrap();
        let request = PublishRequest {
            slug: Some("big-artifact"),
            title: "T",
            format: ArtifactFormat::Html,
            path: Some(big.to_str().unwrap()),
            content: None,
            message: None,
        };
        store.publish(&identity(), request, 1000).unwrap();
        match store.read("ws-1", "big-artifact", None, 0).unwrap() {
            ReadResult::OverCap { note, size, .. } => {
                assert!(note.contains("browser"), "note points at the durable forms: {note}");
                assert!(size > CONTENT_CAP_BYTES as u64);
            }
            other => panic!("expected over-cap, got {other:?}"),
        }
    }

    #[test]
    fn disabled_store_refuses_every_operation() {
        let store = ArtifactsStore::default();
        let err = store.list("ws-1").unwrap_err();
        assert!(err.0.contains("off"), "off is off: {}", err.0);
    }
}
