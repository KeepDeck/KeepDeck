//! Application update policy around Tauri's verifier/installer metadata.
//! Artifact bytes are fetched by the shared download engine, not by a second
//! updater-specific downloader.

use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri_plugin_updater::{Update, UpdaterExt as _};

use crate::downloads;

struct PendingUpdate {
    update: Update,
    target: String,
    signature: String,
    public_key: String,
}

#[derive(Default)]
pub struct AppUpdaterState {
    pending: Mutex<HashMap<String, PendingUpdate>>,
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
        registry.ensure_target_idle(&downloads::target_path("updates")?)?;
        state.pending.lock().expect("poisoned").clear();
        sweep_update_artifacts(None)?;
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
    registry.ensure_target_idle(&downloads::target_path("updates")?)?;
    sweep_update_artifacts(Some(&target))?;
    let downloaded = verified_artifact_exists(&target, &update.signature, &public_key)?;
    let dto = AvailableUpdateDto {
        id: id.clone(),
        version: update.version.clone(),
        url: update.download_url.to_string(),
        signature: update.signature.clone(),
        public_key: public_key.clone(),
        target: target.clone(),
        downloaded,
    };
    let mut pending = state.pending.lock().expect("poisoned");
    pending.clear();
    pending.insert(
        id,
        PendingUpdate {
            signature: update.signature.clone(),
            public_key,
            update,
            target,
        },
    );
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
            .get(&id)
            .ok_or_else(|| format!("unknown update: {id}"))?;
        (
            pending.update.clone(),
            pending.target.clone(),
            pending.signature.clone(),
            pending.public_key.clone(),
        )
    };
    let path = downloads::target_path(&target)?;
    registry.ensure_target_idle(&path)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    // Verify and install this exact allocation. Reopening the path between
    // those operations would allow a local TOCTOU replacement.
    downloads::verify_minisign_bytes(&bytes, &signature, &public_key)?;
    tauri::async_runtime::spawn_blocking(move || update.install(bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    state.pending.lock().expect("poisoned").remove(&id);
    let _ = downloads::remove_relative_path(&target);
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
pub fn app_update_discard(
    id: String,
    state: tauri::State<'_, AppUpdaterState>,
    registry: tauri::State<'_, downloads::DownloadRegistry>,
) -> Result<(), String> {
    let target = state
        .pending
        .lock()
        .expect("poisoned")
        .get(&id)
        .map(|pending| pending.target.clone());
    let Some(target) = target else {
        return Ok(());
    };
    registry.ensure_target_idle(&downloads::target_path(&target)?)?;
    downloads::remove_relative_path(&target)?;
    state.pending.lock().expect("poisoned").remove(&id);
    Ok(())
}

fn sweep_update_artifacts(keep_target: Option<&str>) -> Result<(), String> {
    let directory = downloads::target_path("updates")?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let keep = keep_target.map(downloads::target_path).transpose()?;
    let keep_part = keep.as_ref().map(|path| {
        let mut value = path.as_os_str().to_os_string();
        value.push(".part");
        std::path::PathBuf::from(value)
    });
    sweep_directory(&directory, keep.as_deref(), keep_part.as_deref())
}

fn sweep_directory(
    directory: &std::path::Path,
    keep: Option<&std::path::Path>,
    keep_part: Option<&std::path::Path>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if keep == Some(path.as_path()) || keep_part == Some(path.as_path()) {
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

        sweep_directory(temp.path(), Some(&keep), Some(&keep_part)).unwrap();

        assert!(keep.exists());
        assert!(keep_part.exists());
        assert!(!temp.path().join("old.bundle").exists());
        assert!(!temp.path().join("old.unpack.part").exists());
    }
}
