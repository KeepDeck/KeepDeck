//! Shared download engine. Callers describe sources, targets and integrity;
//! this module owns transfer, resume, verification, unpacking and cancellation.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use url::Url;

use crate::paths;

const CANCELLED: &str = "cancelled";
const RECENT_IDS_LIMIT: usize = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub id: String,
    pub source: DownloadSource,
    pub target: DownloadTarget,
    pub integrity: Option<DownloadIntegrity>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSource {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadTarget {
    File {
        path: String,
    },
    TarGz {
        path: String,
        #[serde(default)]
        expected_files: Vec<String>,
        #[serde(default)]
        strip_single_root: bool,
    },
}

impl DownloadTarget {
    fn path(&self) -> &str {
        match self {
            Self::File { path } | Self::TarGz { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDownloadRequest {
    source: String,
    target: String,
    #[serde(default)]
    strip_single_roots: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadIntegrity {
    Sha256 {
        digest: String,
        bytes: Option<u64>,
    },
    Minisign {
        signature: String,
        public_key: String,
        bytes: Option<u64>,
    },
    Size {
        bytes: u64,
    },
}

impl DownloadIntegrity {
    fn bytes(&self) -> Option<u64> {
        match self {
            Self::Sha256 { bytes, .. } | Self::Minisign { bytes, .. } => *bytes,
            Self::Size { bytes } => Some(*bytes),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStateDto {
    id: String,
    phase: &'static str,
    received: u64,
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
pub struct DownloadRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    active: HashMap<String, ActiveJob>,
    targets: HashMap<PathBuf, String>,
    recent_ids: HashSet<String>,
    recent_order: VecDeque<String>,
}

struct ActiveJob {
    cancelled: Arc<AtomicBool>,
    target: PathBuf,
}

impl DownloadRegistry {
    fn begin(&self, id: &str, target: PathBuf) -> Result<Arc<AtomicBool>, String> {
        if id.trim().is_empty() {
            return Err("download id must not be empty".into());
        }
        let mut inner = self.inner.lock().expect("poisoned");
        if inner.active.contains_key(id) || inner.recent_ids.contains(id) {
            return Err(format!("download id already used: {id}"));
        }
        if let Some((active_target, active_id)) = inner
            .targets
            .iter()
            .find(|(active_target, _)| targets_conflict(active_target, &target))
        {
            return Err(format!(
                "download target conflicts with job {active_id} at {}: {}",
                active_target.display(),
                target.display(),
            ));
        }
        let token = Arc::new(AtomicBool::new(false));
        inner.targets.insert(target.clone(), id.to_string());
        inner.active.insert(
            id.to_string(),
            ActiveJob {
                cancelled: token.clone(),
                target,
            },
        );
        Ok(token)
    }

    fn finish(&self, id: &str) {
        let mut inner = self.inner.lock().expect("poisoned");
        if let Some(job) = inner.active.remove(id) {
            inner.targets.remove(&job.target);
        }
        let id = id.to_string();
        if inner.recent_ids.insert(id.clone()) {
            inner.recent_order.push_back(id);
        }
        while inner.recent_order.len() > RECENT_IDS_LIMIT {
            if let Some(expired) = inner.recent_order.pop_front() {
                inner.recent_ids.remove(&expired);
            }
        }
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let inner = self.inner.lock().expect("poisoned");
        let Some(job) = inner.active.get(id) else {
            // A terminal race is idempotent; an unknown id is still an error.
            return if inner.recent_ids.contains(id) {
                Ok(())
            } else {
                Err(format!("download is not active: {id}"))
            };
        };
        job.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn ensure_target_idle(&self, target: &Path) -> Result<(), String> {
        let inner = self.inner.lock().expect("poisoned");
        if let Some((active_target, id)) = inner
            .targets
            .iter()
            .find(|(active_target, _)| targets_conflict(active_target, target))
        {
            Err(format!(
                "download target conflicts with active job {id} at {}: {}",
                active_target.display(),
                target.display(),
            ))
        } else {
            Ok(())
        }
    }
}

fn targets_conflict(left: &Path, right: &Path) -> bool {
    let overlaps = |a: &Path, b: &Path| a == b || a.starts_with(b) || b.starts_with(a);
    let left_paths = [
        left.to_path_buf(),
        sidecar_path(left, ".part"),
        sidecar_path(left, ".unpack.part"),
    ];
    let right_paths = [
        right.to_path_buf(),
        sidecar_path(right, ".part"),
        sidecar_path(right, ".unpack.part"),
    ];
    left_paths
        .iter()
        .any(|left| right_paths.iter().any(|right| overlaps(left, right)))
}

#[derive(Clone, Copy)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

fn emit(
    channel: &Channel<DownloadStateDto>,
    id: &str,
    phase: &'static str,
    progress: Progress,
    error: Option<String>,
) {
    let _ = channel.send(DownloadStateDto {
        id: id.to_string(),
        phase,
        received: progress.received,
        total: progress.total,
        error,
    });
}

#[tauri::command]
pub async fn download_start(
    request: DownloadRequest,
    on_state: Channel<DownloadStateDto>,
    allowed_domains: Option<Vec<String>>,
    registry: tauri::State<'_, DownloadRegistry>,
) -> Result<(), String> {
    let target = target_path(request.target.path())?;
    let token = registry.begin(&request.id, target.clone())?;
    let id = request.id.clone();
    let initial = Progress {
        received: 0,
        total: request
            .integrity
            .as_ref()
            .and_then(DownloadIntegrity::bytes),
    };
    emit(&on_state, &id, "queued", initial, None);

    let channel = on_state.clone();
    let worker_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = initial;
        let result = run_download(
            &request,
            &target,
            &token,
            &channel,
            &mut progress,
            allowed_domains.as_deref(),
        );
        (result, progress)
    })
    .await
    .map_err(|e| e.to_string());

    registry.finish(&id);
    match result {
        Ok((Ok(()), progress)) => emit(&on_state, &id, "completed", progress, None),
        Ok((Err(error), progress)) if error == CANCELLED => {
            emit(&on_state, &id, "cancelled", progress, None)
        }
        Ok((Err(error), progress)) => emit(&on_state, &id, "failed", progress, Some(error)),
        Err(error) => emit(&on_state, &worker_id, "failed", initial, Some(error)),
    }
    Ok(())
}

#[tauri::command]
pub fn download_cancel(
    id: String,
    registry: tauri::State<'_, DownloadRegistry>,
) -> Result<(), String> {
    registry.cancel(&id)
}

#[tauri::command]
pub fn download_exists(target: DownloadTarget) -> Result<bool, String> {
    let path = target_path(target.path())?;
    match target {
        DownloadTarget::File { .. } => Ok(path.is_file()),
        DownloadTarget::TarGz { expected_files, .. } => {
            Ok(path.is_dir() && holds_expected(&path, &expected_files)?)
        }
    }
}

#[tauri::command]
pub fn download_remove(
    target: DownloadTarget,
    registry: tauri::State<'_, DownloadRegistry>,
) -> Result<(), String> {
    let path = target_path(target.path())?;
    registry.ensure_target_idle(&path)?;
    remove_path(&path)
}

#[tauri::command]
pub fn download_adopt_legacy(
    request: LegacyDownloadRequest,
    registry: tauri::State<'_, DownloadRegistry>,
) -> Result<(), String> {
    let home = paths::keepdeck_home().ok_or("no home directory")?;
    let source = home.join(safe_relative(&request.source)?);
    let target = target_path(&request.target)?;
    registry.ensure_target_idle(&target)?;

    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("legacy download source must be a real directory".into());
    }
    reject_symlinks(&source)?;
    if !target.exists() {
        fs::create_dir_all(target.parent().ok_or("legacy target has no parent")?)
            .map_err(|e| e.to_string())?;
        fs::rename(&source, &target).map_err(|e| e.to_string())?;
    } else {
        merge_legacy_dir(&source, &target)?;
    }
    if request.strip_single_roots {
        flatten_legacy_single_roots(&target)?;
    }
    Ok(())
}

fn run_download(
    request: &DownloadRequest,
    target: &Path,
    cancelled: &AtomicBool,
    channel: &Channel<DownloadStateDto>,
    progress: &mut Progress,
    allowed_domains: Option<&[String]>,
) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "download target already exists: {}",
            request.target.path()
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let part = sidecar_path(&target, ".part");
    if fs::symlink_metadata(&part)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("download partial file must not be a symbolic link".into());
    }
    transfer(
        request,
        &part,
        cancelled,
        channel,
        progress,
        allowed_domains,
    )?;

    if request.integrity.is_some() {
        emit(channel, &request.id, "verifying", *progress, None);
        verify(
            &part,
            request.integrity.as_ref().expect("checked"),
            cancelled,
        )?;
    }
    check_cancelled(cancelled)?;

    match &request.target {
        DownloadTarget::File { .. } => {
            fs::rename(&part, target).map_err(|e| e.to_string())?;
        }
        DownloadTarget::TarGz {
            expected_files,
            strip_single_root,
            ..
        } => {
            emit(channel, &request.id, "unpacking", *progress, None);
            unpack_tar_gz(&part, target, expected_files, *strip_single_root, cancelled)?;
            let _ = fs::remove_file(&part);
        }
    }
    Ok(())
}

fn transfer(
    request: &DownloadRequest,
    part: &Path,
    cancelled: &AtomicBool,
    channel: &Channel<DownloadStateDto>,
    progress: &mut Progress,
    allowed_domains: Option<&[String]>,
) -> Result<(), String> {
    check_cancelled(cancelled)?;
    let expected_bytes = request
        .integrity
        .as_ref()
        .and_then(DownloadIntegrity::bytes);
    let mut restarted = false;
    let (response, mut offset, response_total) = loop {
        let mut offset = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if let Some(expected) = expected_bytes {
            if offset == expected {
                progress.received = offset;
                progress.total = Some(expected);
                emit(channel, &request.id, "downloading", *progress, None);
                return Ok(());
            }
            if offset > expected {
                fs::remove_file(part).map_err(|e| e.to_string())?;
                offset = 0;
            }
        }

        match open_response(request, offset, allowed_domains, cancelled)? {
            OpenResponse::Complete(total) => {
                progress.received = offset;
                progress.total = progress.total.or(Some(total));
                emit(channel, &request.id, "downloading", *progress, None);
                return Ok(());
            }
            OpenResponse::Restart if offset > 0 && !restarted => {
                fs::remove_file(part).map_err(|e| e.to_string())?;
                restarted = true;
            }
            OpenResponse::Restart => {
                return Err("server returned an invalid resume range".into());
            }
            OpenResponse::Response(response) => match validate_response_range(&response, offset) {
                Ok(response_total) => break (response, offset, response_total),
                Err(_) if offset > 0 && !restarted => {
                    fs::remove_file(part).map_err(|e| e.to_string())?;
                    restarted = true;
                }
                Err(error) => return Err(error),
            },
        }
    };

    let file = if offset > 0 && response.status() == 206 {
        fs::OpenOptions::new().append(true).open(part)
    } else {
        offset = 0;
        fs::File::create(part)
    }
    .map_err(|e| e.to_string())?;
    progress.received = offset;
    progress.total = progress.total.or(response_total);
    emit(channel, &request.id, "downloading", *progress, None);

    let mut file = file;
    let mut reader = response.into_reader();
    let mut buffer = [0u8; 64 * 1024];
    let mut since_report = 0u64;
    loop {
        check_cancelled(cancelled)?;
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(_) if cancelled.load(Ordering::SeqCst) => return Err(CANCELLED.into()),
            Err(error) => return Err(format!("network read failed: {error}")),
        };
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        progress.received += count as u64;
        since_report += count as u64;
        if since_report >= 512 * 1024 {
            since_report = 0;
            emit(channel, &request.id, "downloading", *progress, None);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    emit(channel, &request.id, "downloading", *progress, None);
    if let Some(expected) = response_total {
        if progress.received != expected {
            return Err(format!(
                "connection dropped at {} of {} bytes",
                progress.received, expected
            ));
        }
    }
    Ok(())
}

enum OpenResponse {
    Response(ureq::Response),
    /** A 416 whose advertised complete length equals the local partial. */
    Complete(u64),
    /** The remote object and local partial disagree; restart from byte zero. */
    Restart,
}

fn open_response(
    request: &DownloadRequest,
    offset: u64,
    allowed_domains: Option<&[String]>,
    cancelled: &AtomicBool,
) -> Result<OpenResponse, String> {
    // ureq's blocking reader cannot be interrupted by a token. Finite connect
    // and read timeouts bound cancellation latency while keeping the engine
    // dependency-light; a later attempt resumes the same partial.
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(5))
        .build();
    let initial = Url::parse(&request.source.url).map_err(|e| format!("invalid URL: {e}"))?;
    let initial_origin = initial.origin();
    let mut url = initial;
    for _ in 0..=10 {
        check_cancelled(cancelled)?;
        ensure_allowed_url(&url, allowed_domains)?;
        let mut call = agent.get(url.as_str());
        // Never forward caller-provided credentials across origins. Range is
        // engine-owned and safe to repeat on every hop.
        if url.origin() == initial_origin {
            for (name, value) in &request.source.headers {
                call = call.set(name, value);
            }
        }
        if offset > 0 {
            call = call.set("Range", &format!("bytes={offset}-"));
        }
        let response = match call.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(416, response)) if offset > 0 => {
                return match unsatisfied_range_total(&response) {
                    Some(total) if total == offset => Ok(OpenResponse::Complete(total)),
                    Some(_) => Ok(OpenResponse::Restart),
                    None => Ok(OpenResponse::Restart),
                };
            }
            Err(error) => return Err(humanize_http(error)),
        };
        if !matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
            return Ok(OpenResponse::Response(response));
        }
        let location = response
            .header("Location")
            .ok_or("download redirect has no Location header")?;
        let next = url
            .join(location)
            .map_err(|e| format!("invalid download redirect: {e}"))?;
        if url.scheme() == "https" && next.scheme() != "https" {
            return Err("download redirect would downgrade HTTPS".into());
        }
        url = next;
    }
    Err("download followed too many redirects".into())
}

#[derive(Debug, PartialEq, Eq)]
struct ContentRange {
    start: u64,
    end: u64,
    total: Option<u64>,
}

fn parse_content_range(value: &str) -> Option<ContentRange> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    if end < start {
        return None;
    }
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    Some(ContentRange { start, end, total })
}

fn unsatisfied_range_total(response: &ureq::Response) -> Option<u64> {
    response
        .header("Content-Range")?
        .strip_prefix("bytes */")?
        .parse()
        .ok()
}

fn validate_response_range(
    response: &ureq::Response,
    requested_offset: u64,
) -> Result<Option<u64>, String> {
    let length = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    if response.status() != 206 {
        return Ok(length);
    }
    let range = response
        .header("Content-Range")
        .and_then(parse_content_range)
        .ok_or("HTTP 206 response has no valid Content-Range")?;
    if range.start != requested_offset {
        return Err(format!(
            "resume offset mismatch: requested {requested_offset}, server started at {}",
            range.start
        ));
    }
    let range_length = range.end - range.start + 1;
    if length.is_some_and(|length| length != range_length) {
        return Err("Content-Length does not match Content-Range".into());
    }
    if range.total.is_some_and(|total| range.end >= total) {
        return Err("Content-Range ends outside the remote object".into());
    }
    Ok(range.total.or(Some(range.end + 1)))
}

fn ensure_allowed_url(url: &Url, allowed_domains: Option<&[String]>) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("unsupported download URL scheme: {}", url.scheme()));
    }
    let Some(domains) = allowed_domains else {
        return Ok(());
    };
    let host = url.host_str().ok_or("download URL has no host")?;
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    if domains
        .iter()
        .any(|domain| domain.eq_ignore_ascii_case(&authority))
    {
        Ok(())
    } else {
        Err(format!("download host is not allowed: {authority}"))
    }
}

fn verify(
    path: &Path,
    integrity: &DownloadIntegrity,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    if let Some(expected) = integrity.bytes() {
        let actual = fs::metadata(path).map_err(|e| e.to_string())?.len();
        if actual != expected {
            let _ = fs::remove_file(path);
            return Err(format!(
                "size mismatch: expected {expected} bytes, got {actual}"
            ));
        }
    }
    match integrity {
        DownloadIntegrity::Sha256 { digest, .. } => {
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                check_cancelled(cancelled)?;
                let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(digest) {
                let _ = fs::remove_file(path);
                return Err("checksum mismatch — the download was corrupted".into());
            }
        }
        DownloadIntegrity::Minisign {
            signature,
            public_key,
            ..
        } => {
            check_cancelled(cancelled)?;
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            let result = verify_minisign_bytes(&bytes, signature, public_key);
            if let Err(error) = result {
                // A cryptographically invalid prefix can never become valid by
                // resuming onto it. Start a later attempt from clean bytes.
                let _ = fs::remove_file(path);
                return Err(error);
            }
            check_cancelled(cancelled)?;
        }
        DownloadIntegrity::Size { .. } => {}
    }
    Ok(())
}

/** Verify the exact byte buffer a caller will consume afterwards. */
pub(crate) fn verify_minisign_bytes(
    bytes: &[u8],
    signature: &str,
    public_key: &str,
) -> Result<(), String> {
    let public_key = decode_base64_text(public_key)?;
    let signature = decode_base64_text(signature)?;
    let public_key = PublicKey::decode(&public_key).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&signature).map_err(|e| e.to_string())?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|e| format!("signature verification failed: {e}"))
}

fn decode_base64_text(value: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|e| e.to_string())?;
    String::from_utf8(decoded).map_err(|e| e.to_string())
}

fn unpack_tar_gz(
    archive: &Path,
    target: &Path,
    expected_files: &[String],
    strip_single_root: bool,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let staging = sidecar_path(target, ".unpack.part");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    for entry in tar.entries().map_err(|e| format!("extract failed: {e}"))? {
        check_cancelled(cancelled)?;
        let mut entry = entry.map_err(|e| format!("extract failed: {e}"))?;
        if !entry
            .unpack_in(&staging)
            .map_err(|e| format!("extract failed: {e}"))?
        {
            return Err("archive entry escapes its target directory".into());
        }
    }
    reject_symlinks(&staging)?;

    let publish = if holds_expected(&staging, expected_files)? {
        staging.clone()
    } else if strip_single_root {
        let candidates = fs::read_dir(&staging)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| holds_expected(path, expected_files).unwrap_or(false))
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return Err("archive does not contain the expected files".into());
        }
        candidates[0].clone()
    } else {
        return Err("archive does not contain the expected files".into());
    };
    check_cancelled(cancelled)?;
    fs::rename(&publish, target).map_err(|e| e.to_string())?;
    if publish != staging {
        let _ = fs::remove_dir_all(staging);
    }
    Ok(())
}

fn reject_symlinks(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("symbolic links are not supported in download artifacts".into());
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            return Err("archives containing symbolic links are not supported".into());
        }
        if file_type.is_dir() {
            reject_symlinks(&entry.path())?;
        }
    }
    Ok(())
}

fn merge_legacy_dir(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let from_type = fs::symlink_metadata(&from)
            .map_err(|e| e.to_string())?
            .file_type();
        if from_type.is_symlink() {
            return Err("symbolic links are not supported in legacy downloads".into());
        }
        let to_type = match fs::symlink_metadata(&to) {
            Ok(metadata) => metadata.file_type(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&from, &to).map_err(|e| e.to_string())?;
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        if from_type.is_dir() && to_type.is_dir() && !to_type.is_symlink() {
            merge_legacy_dir(&from, &to)?;
        } else {
            fs::rename(&from, available_legacy_name(&to)).map_err(|e| e.to_string())?;
        }
    }
    if fs::read_dir(source)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        fs::remove_dir(source).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn available_legacy_name(path: &Path) -> PathBuf {
    for index in 1.. {
        let mut candidate = path.as_os_str().to_os_string();
        candidate.push(format!(".legacy-{index}"));
        let candidate = PathBuf::from(candidate);
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    unreachable!()
}

fn flatten_legacy_single_roots(models: &Path) -> Result<(), String> {
    for entry in fs::read_dir(models).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let model = entry.path();
        let children = fs::read_dir(&model)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if children.len() == 1 && children[0].file_type().map_err(|e| e.to_string())?.is_dir() {
            merge_legacy_dir(&children[0].path(), &model)?;
        }
    }
    Ok(())
}

fn holds_expected(root: &Path, expected_files: &[String]) -> Result<bool, String> {
    for relative in expected_files {
        let relative = safe_relative(relative)?;
        if !root.join(relative).is_file() {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn target_path(relative: &str) -> Result<PathBuf, String> {
    let relative = safe_relative(relative)?;
    let root = paths::keepdeck_home()
        .ok_or("no home directory")?
        .join("downloads");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("download root must not be a symbolic link".into());
    }
    let mut cursor = root.clone();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        if fs::symlink_metadata(&cursor)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(format!(
                "download path must not cross a symbolic link: {}",
                cursor.display()
            ));
        }
    }
    Ok(root.join(relative))
}

pub(crate) fn remove_relative_path(relative: &str) -> Result<(), String> {
    let path = target_path(relative)?;
    remove_path(&path)
}

fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    } else if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    for sidecar in [
        sidecar_path(&path, ".part"),
        sidecar_path(&path, ".unpack.part"),
    ] {
        if sidecar.is_dir() {
            let _ = fs::remove_dir_all(sidecar);
        } else {
            let _ = fs::remove_file(sidecar);
        }
    }
    Ok(())
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "download path must be a safe relative path: {value}"
        ));
    }
    Ok(path.to_path_buf())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

fn humanize_http(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, _) => format!("download failed with HTTP {code}"),
        ureq::Error::Transport(error) => error
            .message()
            .map(|message| format!("network error: {message}"))
            .unwrap_or_else(|| "network error".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_targets() {
        assert!(safe_relative("../secret").is_err());
        assert!(safe_relative("/absolute").is_err());
        assert!(safe_relative("models/good.bin").is_ok());
    }

    #[test]
    fn percent_integrity_bytes_are_shared_by_all_variants() {
        assert_eq!(DownloadIntegrity::Size { bytes: 7 }.bytes(), Some(7));
        assert_eq!(
            DownloadIntegrity::Sha256 {
                digest: "abc".into(),
                bytes: None,
            }
            .bytes(),
            None
        );
    }

    #[test]
    fn redirect_policy_uses_exact_declared_hosts() {
        let allowed = vec![
            "FILES.example.com".to_string(),
            "localhost:3000".to_string(),
        ];
        assert!(ensure_allowed_url(
            &Url::parse("https://files.example.com/model").unwrap(),
            Some(&allowed),
        )
        .is_ok());
        assert!(ensure_allowed_url(
            &Url::parse("https://cdn.example.com/model").unwrap(),
            Some(&allowed),
        )
        .is_err());
        assert!(ensure_allowed_url(
            &Url::parse("http://localhost:3000/model").unwrap(),
            Some(&allowed),
        )
        .is_ok());
        assert!(ensure_allowed_url(
            &Url::parse("http://localhost:3001/model").unwrap(),
            Some(&allowed),
        )
        .is_err());
    }

    #[test]
    fn parses_and_validates_resume_ranges() {
        assert_eq!(
            parse_content_range("bytes 10-19/20"),
            Some(ContentRange {
                start: 10,
                end: 19,
                total: Some(20),
            })
        );
        assert!(parse_content_range("bytes 20-10/21").is_none());
        assert!(parse_content_range("items 0-1/2").is_none());
    }

    #[test]
    fn registry_reserves_targets_and_bounds_recent_ids() {
        let registry = DownloadRegistry::default();
        let first = PathBuf::from("/tmp/download-one");
        registry.begin("one", first.clone()).unwrap();
        assert!(registry.begin("two", first.clone()).is_err());
        assert!(registry.begin("child", first.join("nested/file")).is_err());
        assert!(registry
            .begin("sidecar", PathBuf::from("/tmp/download-one.part"))
            .is_err());
        assert!(registry.ensure_target_idle(Path::new("/tmp")).is_err());
        registry.finish("one");
        assert!(registry.begin("two", first).is_ok());
        registry.finish("two");

        for index in 0..=RECENT_IDS_LIMIT {
            let id = format!("recent-{index}");
            registry
                .begin(&id, PathBuf::from(format!("/tmp/{id}")))
                .unwrap();
            registry.finish(&id);
        }
        let inner = registry.inner.lock().unwrap();
        assert_eq!(inner.recent_ids.len(), RECENT_IDS_LIMIT);
        assert!(!inner.recent_ids.contains("recent-0"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_in_extracted_archives() {
        let temp = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/tmp", temp.path().join("escape")).unwrap();
        assert!(reject_symlinks(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_legacy_source_that_is_itself_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = temp.path().join("models");
        std::os::unix::fs::symlink(outside.path(), &source).unwrap();
        assert!(reject_symlinks(&source).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_merge_never_follows_existing_target_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(source.join("models"), b"legacy").unwrap();
        std::os::unix::fs::symlink(&outside, target.join("models")).unwrap();

        merge_legacy_dir(&source, &target).unwrap();

        assert!(target
            .join("models")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(target.join("models.legacy-1")).unwrap(), b"legacy");
        assert!(fs::read_dir(outside).unwrap().next().is_none());
    }
}
