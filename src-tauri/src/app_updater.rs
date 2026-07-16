//! Application update policy around Tauri's verifier/installer metadata.
//! Artifact bytes are fetched by the shared download engine, not by a second
//! updater-specific downloader.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri_plugin_updater::{Update, UpdaterExt as _};

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
    let public_key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|value| value.as_str())
        .ok_or("updater public key is not configured")?
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
    let dto = AvailableUpdateDto {
        id: id.clone(),
        version: update.version.clone(),
        url: update.download_url.to_string(),
        signature: update.signature.clone(),
        public_key: public_key.clone(),
        target: target.clone(),
        downloaded,
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
}
