//! Application update policy around Tauri's verifier/installer metadata.
//! Artifact bytes are fetched by the shared download engine, not by a second
//! updater-specific downloader.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_updater::{Update, UpdaterExt as _};
use url::Url;

use crate::downloads;

struct PendingUpdate {
    id: String,
    update: Update,
    target: String,
    signature: String,
    public_key: String,
}

#[derive(Default)]
pub struct AppUpdaterState {
    pending: Mutex<Option<PendingUpdate>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdateDto {
    id: String,
    version: String,
    url: String,
    signature: String,
    public_key: String,
    target: String,
    downloaded: bool,
    /// Accumulated release notes a user moving to this update should see:
    /// every published release between their installed version and this one.
    /// Empty when the channel has no `changelog.json` yet, or the fetch or
    /// parse failed (the update itself stays valid either way).
    changelog: Vec<ChangelogEntry>,
}

/// One published release's notes, as carried by the channel's `changelog.json`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    version: String,
    notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
}

/// `changelog.json` on the release channel — a versioned envelope around the
/// per-release list. Only `releases` is consumed; `schema`/`generatedAt` are
/// read tolerantly so a future schema bump doesn't break an older client.
#[derive(Deserialize)]
struct ChangelogManifest {
    #[serde(default)]
    #[allow(dead_code)]
    schema: u32,
    #[serde(default)]
    #[allow(dead_code)]
    generated_at: Option<String>,
    #[serde(default)]
    releases: Vec<ChangelogEntry>,
}

#[tauri::command]
pub async fn app_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdaterState>,
    registry: tauri::State<'_, downloads::DownloadRegistry>,
) -> Result<Option<AvailableUpdateDto>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        let directory = downloads::target_path("updates")?;
        let lease = registry.reserve_target(directory, "update artifact sweep")?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            sweep_update_artifacts(None)
        })
        .await
        .map_err(|e| e.to_string())??;
        *state.pending.lock().expect("poisoned") = None;
        return Ok(None);
    };
    let updater_config = app
        .config()
        .plugins
        .0
        .get("updater")
        .ok_or("updater is not configured")?;
    let public_key = updater_config
        .get("pubkey")
        .and_then(|value| value.as_str())
        .ok_or("updater public key is not configured")?
        .to_string();
    let endpoint = updater_config
        .get("endpoints")
        .and_then(|value| value.as_array())
        .and_then(|array| array.first())
        .and_then(|value| value.as_str())
        .ok_or("updater endpoint is not configured")?
        .to_string();
    let id = artifact_id(update.download_url.as_str(), &update.signature);
    let target = format!("updates/{id}.bundle");
    let directory = downloads::target_path("updates")?;
    let lease = registry.reserve_target(directory, "update artifact check")?;
    let check_target = target.clone();
    let check_signature = update.signature.clone();
    let check_public_key = public_key.clone();
    let downloaded = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        sweep_update_artifacts(Some(&check_target))?;
        verified_artifact_exists(&check_target, &check_signature, &check_public_key)
    })
    .await
    .map_err(|e| e.to_string())??;
    // Pull the accumulated changelog alongside the artifact check. This is a
    // separate blocking task (ureq must stay off the async runtime, like the
    // kimi usages fetch); failure is non-fatal — the update is still valid and
    // installable, the user just sees no notes. Most common miss: the channel
    // has not published changelog.json yet. A task panic is caught here too so
    // the docstring's "non-fatal" promise holds for every failure mode.
    let changelog = match tauri::async_runtime::spawn_blocking(move || {
        match fetch_changelog(&endpoint) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!("changelog unavailable: {error}");
                Vec::new()
            }
        }
    })
    .await
    {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("changelog task failed: {error}");
            Vec::new()
        }
    };
    let dto = AvailableUpdateDto {
        id: id.clone(),
        version: update.version.clone(),
        url: update.download_url.to_string(),
        signature: update.signature.clone(),
        public_key: public_key.clone(),
        target: target.clone(),
        downloaded,
        changelog,
    };
    *state.pending.lock().expect("poisoned") = Some(PendingUpdate {
        id,
        signature: update.signature.clone(),
        public_key,
        update,
        target,
    });
    Ok(Some(dto))
}

#[tauri::command]
pub async fn app_update_install(
    id: String,
    state: tauri::State<'_, AppUpdaterState>,
    registry: tauri::State<'_, downloads::DownloadRegistry>,
) -> Result<(), String> {
    let (update, target, signature, public_key) = {
        let pending = state.pending.lock().expect("poisoned");
        let pending = pending
            .as_ref()
            .filter(|pending| pending.id == id)
            .ok_or_else(|| format!("unknown update: {id}"))?;
        (
            pending.update.clone(),
            pending.target.clone(),
            pending.signature.clone(),
            pending.public_key.clone(),
        )
    };
    let path = downloads::target_path(&target)?;
    let lease = registry.reserve_target(path.clone(), "update install")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        // Verify and install this exact allocation. Reopening the path between
        // those operations would allow a local TOCTOU replacement.
        downloads::verify_minisign_bytes(&bytes, &signature, &public_key)?;
        update.install(bytes).map_err(|e| e.to_string())?;
        if let Err(error) = downloads::remove_relative_path(&target) {
            log::warn!("installed update artifact cleanup failed: {error}");
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut pending = state.pending.lock().expect("poisoned");
    if pending.as_ref().is_some_and(|pending| pending.id == id) {
        *pending = None;
    }
    Ok(())
}

fn artifact_id(url: &str, signature: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(url.as_bytes());
    digest.update([0]);
    digest.update(signature.as_bytes());
    format!("{:x}", digest.finalize())
}

/// Replace the manifest filename in `endpoint` with `name`, keeping scheme,
/// host and directory intact. Derives the changelog URL from the configured
/// updater endpoint so no second URL needs configuring.
fn sibling_url(endpoint: &str, name: &str) -> Result<String, String> {
    let mut url = Url::parse(endpoint).map_err(|e| format!("invalid updater endpoint: {e}"))?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| "updater endpoint cannot be a base".to_string())?;
    segments.pop();
    segments.push(name);
    drop(segments);
    Ok(url.to_string())
}

/// A changelog is a few KB of JSON; cap the fetch so a misconfigured or
/// compromised endpoint can't exhaust memory or stall the check. Two MiB is
/// ~100x any realistic release-notes document.
const MAX_CHANGELOG_BYTES: u64 = 2 * 1024 * 1024;

/// Fetch a small artifact's bytes with a tight timeout and a hard size cap.
/// Used for the changelog — never the update bundle (that goes through the
/// resumable download engine, which caps via its integrity metadata).
fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(changelog_http_error)?;
    if let Some(len) = announced_length(response.header("Content-Length")) {
        return Err(format!(
            "changelog too large: {len} bytes (limit {MAX_CHANGELOG_BYTES})"
        ));
    }
    let mut bytes = Vec::new();
    // `.take` bounds the read even when Content-Length is missing or lies; a
    // truncated body then fails to parse downstream (non-fatal, empty list).
    response
        .into_reader()
        .take(MAX_CHANGELOG_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("changelog body unreadable: {e}"))?;
    Ok(bytes)
}

/// The Content-Length, when the header both parses as an integer AND exceeds
/// the cap — the fetch's fast-fail gate. Returns the offending length so the
/// error names it; `None` (header absent, unparsable, or within the cap) means
/// let the `.take` bound enforce the read instead. Extracted so the security
/// decision is unit-testable without a live socket.
fn announced_length(header: Option<&str>) -> Option<u64> {
    header
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&len| len > MAX_CHANGELOG_BYTES)
}

fn changelog_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, _) => format!("changelog HTTP {code}"),
        other => format!("changelog request failed: {other}"),
    }
}

/// Parse `changelog.json` into its release entries. Only `releases` is read;
/// the envelope (`schema`, `generatedAt`) is tolerated so a future schema bump
/// degrades to "no notes" rather than breaking older clients.
fn parse_changelog(bytes: &[u8]) -> Result<Vec<ChangelogEntry>, String> {
    let manifest: ChangelogManifest =
        serde_json::from_slice(bytes).map_err(|e| format!("changelog.json unreadable: {e}"))?;
    Ok(manifest.releases)
}

/// Fetch and parse the channel's accumulated changelog. The changelog is
/// display-only release notes; the update BUNDLE remains the integrity-
/// critical artifact and is minisign-verified separately on install. If a
/// future hardening signs the changelog, a `changelog.sig` fetched alongside
/// and `downloads::verify_minisign_bytes(&bytes, &sig, public_key)` here is
/// the whole change — the DTO and UI stay as-is.
fn fetch_changelog(endpoint: &str) -> Result<Vec<ChangelogEntry>, String> {
    let json_url = sibling_url(endpoint, "changelog.json")?;
    let bytes = fetch_bytes(&json_url)?;
    parse_changelog(&bytes)
}

fn verified_artifact_exists(
    target: &str,
    signature: &str,
    public_key: &str,
) -> Result<bool, String> {
    let path = downloads::target_path(target)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if downloads::verify_minisign_bytes(&bytes, signature, public_key).is_ok() {
        Ok(true)
    } else {
        downloads::remove_relative_path(target)?;
        Ok(false)
    }
}

#[tauri::command]
pub async fn app_update_discard(
    id: String,
    state: tauri::State<'_, AppUpdaterState>,
    registry: tauri::State<'_, downloads::DownloadRegistry>,
) -> Result<(), String> {
    let target = state
        .pending
        .lock()
        .expect("poisoned")
        .as_ref()
        .filter(|pending| pending.id == id)
        .map(|pending| pending.target.clone());
    let Some(target) = target else {
        return Ok(());
    };
    let path = downloads::target_path(&target)?;
    let lease = registry.reserve_target(path, "update discard")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        downloads::remove_relative_path(&target)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut pending = state.pending.lock().expect("poisoned");
    if pending.as_ref().is_some_and(|pending| pending.id == id) {
        *pending = None;
    }
    Ok(())
}

fn sweep_update_artifacts(keep_target: Option<&str>) -> Result<(), String> {
    let directory = downloads::target_path("updates")?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let keep = keep_target
        .map(downloads::target_path)
        .transpose()?
        .map(artifact_paths)
        .unwrap_or_default();
    sweep_directory(&directory, &keep)
}

fn artifact_paths(target: PathBuf) -> Vec<PathBuf> {
    let part = sidecar(&target, ".part");
    vec![target, part.clone(), sidecar(&part, ".meta")]
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn sweep_directory(directory: &Path, keep: &[PathBuf]) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if keep.iter().any(|candidate| candidate == &path) {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() && !file_type.is_symlink() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_id_is_stable_and_bound_to_signature() {
        assert_eq!(
            artifact_id("https://example.test/a", "sig"),
            artifact_id("https://example.test/a", "sig")
        );
        assert_ne!(
            artifact_id("https://example.test/a", "sig"),
            artifact_id("https://example.test/a", "other")
        );
    }

    #[test]
    fn artifact_sweep_keeps_only_the_resumable_current_update() {
        let temp = tempfile::tempdir().unwrap();
        let keep = temp.path().join("current.bundle");
        let keep_part = temp.path().join("current.bundle.part");
        fs::write(&keep, b"bundle").unwrap();
        fs::write(&keep_part, b"partial").unwrap();
        fs::write(temp.path().join("old.bundle"), b"old").unwrap();
        fs::create_dir(temp.path().join("old.unpack.part")).unwrap();

        let keep_metadata = temp.path().join("current.bundle.part.meta");
        fs::write(&keep_metadata, b"metadata").unwrap();

        sweep_directory(
            temp.path(),
            &[keep.clone(), keep_part.clone(), keep_metadata.clone()],
        )
        .unwrap();

        assert!(keep.exists());
        assert!(keep_part.exists());
        assert!(keep_metadata.exists());
        assert!(!temp.path().join("old.bundle").exists());
        assert!(!temp.path().join("old.unpack.part").exists());
    }

    #[test]
    fn sibling_url_replaces_only_the_manifest_filename() {
        let endpoint =
            "https://github.com/KeepDeck/KeepDeck/releases/download/latest/latest.json";
        assert_eq!(
            sibling_url(endpoint, "changelog.json").unwrap(),
            "https://github.com/KeepDeck/KeepDeck/releases/download/latest/changelog.json"
        );
        assert_eq!(
            sibling_url(endpoint, "changelog.sig").unwrap(),
            "https://github.com/KeepDeck/KeepDeck/releases/download/latest/changelog.sig"
        );
    }

    #[test]
    fn sibling_url_preserves_query_and_fragment() {
        let endpoint =
            "https://example.test/path/latest.json?token=abc#frag";
        assert_eq!(
            sibling_url(endpoint, "changelog.json").unwrap(),
            "https://example.test/path/changelog.json?token=abc#frag"
        );
    }

    #[test]
    fn parse_changelog_reads_releases_and_tolerates_envelope_fields() {
        let json = br#"{"schema":1,"generatedAt":"2026-07-22T10:00:00Z","releases":[
            {"version":"0.16.0","notes":"sixteen","date":"2026-07-20"},
            {"version":"0.15.0","notes":"fifteen"}
        ]}"#;
        let entries = parse_changelog(json).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].version, "0.16.0");
        assert_eq!(entries[0].notes, "sixteen");
        assert_eq!(entries[0].date.as_deref(), Some("2026-07-20"));
        assert_eq!(entries[1].date, None);
    }

    #[test]
    fn parse_changelog_defaults_to_empty_releases() {
        assert!(parse_changelog(b"{\"schema\":1}").unwrap().is_empty());
        assert!(parse_changelog(b"{}").unwrap().is_empty());
    }

    #[test]
    fn parse_changelog_rejects_malformed_json() {
        assert!(parse_changelog(b"not json").is_err());
        // `releases` must be a list when present.
        assert!(parse_changelog(b"{\"releases\":\"nope\"}").is_err());
    }

    #[test]
    fn announced_length_flags_only_oversized_valid_headers() {
        // Within the cap — no fast-fail (the .take bound still enforces the read).
        assert_eq!(announced_length(Some("0")), None);
        assert_eq!(
            announced_length(Some(&format!("{}", MAX_CHANGELOG_BYTES))),
            None
        );
        // Over the cap — the offending length surfaces in the error.
        let over = MAX_CHANGELOG_BYTES + 1;
        assert_eq!(announced_length(Some(&over.to_string())), Some(over));
        // Absent or unparseable — unknown, let the read bound handle it.
        assert_eq!(announced_length(None), None);
        assert_eq!(announced_length(Some("chunked")), None);
    }
}
