//! Voice — the delivery layer over `keepdeck-voice`: a fixed whisper model
//! registry with download-on-demand (weights are NEVER bundled), one active
//! push-to-talk capture at a time, and batch transcription on stop.
//!
//! cpal's input stream is !Send, so a capture runs on its own thread that
//! OWNS the recorder; the managed state holds only the channels that command
//! it. The loaded whisper context is cached per model path — loading
//! large-v3-turbo takes seconds and must not happen per utterance.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use keepdeck_voice::{
    is_silence, resample, rms, ParakeetEngine, Recorder, WhisperEngine, WHISPER_SAMPLE_RATE,
};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::paths;

#[derive(Clone, Copy, PartialEq)]
enum EngineType {
    Whisper,
    Parakeet,
}

/// How a model's payload arrives.
enum Payload {
    /// One flat file at the models root — whisper's original layout, kept
    /// so existing installs stay installed. Completeness is held to the
    /// response's Content-Length; `bytes` only feeds the progress bar.
    File {
        url: &'static str,
        name: &'static str,
        bytes: u64,
    },
    /// One tar.gz holding `contents`, unpacked into the model's folder. The
    /// whole archive is held to `sha256` BEFORE anything is extracted.
    Archive {
        url: &'static str,
        bytes: u64,
        sha256: &'static str,
        contents: &'static [&'static str],
    },
}

/// The downloadable model registry — every entry is MULTILINGUAL with
/// Russian covered.
struct ModelSpec {
    id: &'static str,
    label: &'static str,
    size_mb: u32,
    engine: EngineType,
    payload: Payload,
}

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "whisper-base-q5_1",
        label: "Whisper Base — fastest, good for short commands",
        size_mb: 60,
        engine: EngineType::Whisper,
        payload: Payload::File {
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
            name: "ggml-base-q5_1.bin",
            bytes: 60_000_000,
        },
    },
    ModelSpec {
        id: "whisper-small-q5_1",
        label: "Whisper Small — balanced",
        size_mb: 190,
        engine: EngineType::Whisper,
        payload: Payload::File {
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
            name: "ggml-small-q5_1.bin",
            bytes: 190_000_000,
        },
    },
    ModelSpec {
        id: "whisper-large-v3-turbo-q5_0",
        label: "Whisper Large v3 Turbo — best accuracy, for dictation",
        size_mb: 574,
        engine: EngineType::Whisper,
        payload: Payload::File {
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
            name: "ggml-large-v3-turbo-q5_0.bin",
            bytes: 574_000_000,
        },
    },
    // The istupakov ONNX export, bundled by Handy — HF's Xet CDN answers
    // anonymous downloads of the flat files with 403 (verified with plain
    // curl), so the archive mirror is the reliable source. int8, CC-BY-4.0.
    ModelSpec {
        id: "parakeet-tdt-0.6b-v3",
        label: "Parakeet TDT 0.6B v3 — fast and accurate, commands and dictation",
        size_mb: 456,
        engine: EngineType::Parakeet,
        payload: Payload::Archive {
            url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz",
            bytes: 478_517_071,
            sha256: "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77",
            contents: &[
                "vocab.txt",
                "nemo128.onnx",
                "encoder-model.int8.onnx",
                "decoder_joint-model.int8.onnx",
            ],
        },
    },
];

fn spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown voice model \"{id}\""))
}

fn models_dir() -> Result<PathBuf, String> {
    let dir = paths::keepdeck_home()
        .ok_or("no home directory")?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Where a model's files live: single-file models sit flat in the models
/// root (whisper's original layout); archives unpack into their own folder.
fn install_dir(m: &ModelSpec) -> Result<PathBuf, String> {
    let root = models_dir()?;
    match &m.payload {
        Payload::File { .. } => Ok(root),
        Payload::Archive { .. } => Ok(root.join(m.id)),
    }
}

/// The directory that actually HOLDS an archive model's contents: the
/// install dir itself, or — when the tarball carries one wrapping folder —
/// that single child. Checked against the payload's content list, so a
/// half-extracted model never reads as installed.
fn archive_root(
    dir: &std::path::Path,
    contents: &[&str],
) -> Option<PathBuf> {
    let holds_all =
        |d: &std::path::Path| contents.iter().all(|name| d.join(name).exists());
    if holds_all(dir) {
        return Some(dir.to_path_buf());
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && holds_all(&path) {
            return Some(path);
        }
    }
    None
}

/// The path the engine loads from — a file for whisper, the content
/// directory for parakeet. None when not (fully) installed.
fn load_path(m: &ModelSpec) -> Result<Option<PathBuf>, String> {
    let dir = install_dir(m)?;
    match &m.payload {
        Payload::File { name, .. } => {
            let path = dir.join(name);
            Ok(path.exists().then_some(path))
        }
        Payload::Archive { contents, .. } => Ok(archive_root(&dir, contents)),
    }
}

fn installed(m: &ModelSpec) -> Result<bool, String> {
    Ok(load_path(m)?.is_some())
}

// ---------------------------------------------------------------- capture --

enum CaptureCmd {
    Stop,
    Cancel,
}

struct ActiveCapture {
    cmd_tx: Sender<CaptureCmd>,
    out_rx: Receiver<Option<(Vec<f32>, u32)>>,
}

/// The loaded engine, cached by model id — loading takes seconds and must
/// not happen per utterance. Parakeet's decoder is stateful (`&mut`), so its
/// arm carries the serializing lock.
enum CachedEngine {
    Whisper(Arc<WhisperEngine>),
    Parakeet(Arc<Mutex<ParakeetEngine>>),
}

impl Clone for CachedEngine {
    fn clone(&self) -> Self {
        match self {
            CachedEngine::Whisper(e) => CachedEngine::Whisper(e.clone()),
            CachedEngine::Parakeet(e) => CachedEngine::Parakeet(e.clone()),
        }
    }
}

#[derive(Default)]
pub struct VoiceState {
    capture: Mutex<Option<ActiveCapture>>,
    engine: Mutex<Option<(String, CachedEngine)>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelDto {
    id: String,
    label: String,
    size_mb: u32,
    installed: bool,
}

#[tauri::command]
pub fn voice_model_list() -> Result<Vec<VoiceModelDto>, String> {
    MODELS
        .iter()
        .map(|m| {
            Ok(VoiceModelDto {
                id: m.id.to_string(),
                label: m.label.to_string(),
                size_mb: m.size_mb,
                installed: installed(m)?,
            })
        })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Stream one URL to `dest` with progress against `total`, returning the
/// byte count and the running SHA-256. Writes go to the path verbatim — the
/// caller owns .part naming and the rename/extract that makes the result
/// count as installed.
fn fetch_to(
    url: &str,
    dest: &std::path::Path,
    total: u64,
    on_progress: &Channel<DownloadProgress>,
) -> Result<(u64, String), String> {
    use sha2::{Digest, Sha256};

    let response = ureq::get(url).call().map_err(|e| e.to_string())?;
    let expected = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_reported: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        received += n as u64;
        // ~every 512 KiB: often enough for a live bar, rare enough to stay
        // off the IPC hot path.
        if received - last_reported >= 512 * 1024 {
            last_reported = received;
            let _ = on_progress.send(DownloadProgress {
                received,
                total: Some(total),
            });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    // A truncated body (connection cut) must not survive: when the server
    // told us the size, hold the transfer to it.
    if let Some(expected) = expected {
        if received != expected {
            let _ = fs::remove_file(dest);
            return Err(format!(
                "download incomplete: {received} of {expected} bytes"
            ));
        }
    }
    Ok((received, format!("{:x}", hasher.finalize())))
}

/// Download a model with one progress feed. A plain file lands as
/// `<name>.part` and renames on completion; an archive is checksum-verified
/// BEFORE extraction and deleted after — an aborted or tampered download
/// never masquerades as installed.
#[tauri::command]
pub async fn voice_model_download(
    id: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    let m = spec(&id)?;
    if installed(m)? {
        return Ok(());
    }
    let dir = install_dir(m)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        match &m.payload {
            Payload::File { url, name, bytes } => {
                let final_path = dir.join(name);
                let part_path = final_path.with_extension("part");
                let (received, _) = fetch_to(url, &part_path, *bytes, &on_progress)?;
                fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
                let _ = on_progress.send(DownloadProgress {
                    received,
                    total: Some(received),
                });
            }
            Payload::Archive {
                url,
                bytes,
                sha256,
                contents: _,
            } => {
                let archive_path = dir.join("payload.tar.gz.part");
                let (received, digest) =
                    fetch_to(url, &archive_path, *bytes, &on_progress)?;
                if digest != *sha256 {
                    let _ = fs::remove_file(&archive_path);
                    return Err(format!(
                        "checksum mismatch for {}: got {digest}",
                        m.id
                    ));
                }
                let file = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
                let tar = flate2::read::GzDecoder::new(file);
                // `unpack` refuses absolute paths and `..` escapes.
                tar::Archive::new(tar)
                    .unpack(&dir)
                    .map_err(|e| format!("extract failed: {e}"))?;
                let _ = fs::remove_file(&archive_path);
                let _ = on_progress.send(DownloadProgress {
                    received,
                    total: Some(received),
                });
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn voice_model_delete(
    id: String,
    state: tauri::State<'_, VoiceState>,
) -> Result<(), String> {
    let m = spec(&id)?;
    // Drop a cached engine holding this model before unlinking it.
    {
        let mut engine = state.engine.lock().expect("poisoned");
        if engine.as_ref().is_some_and(|(cached, _)| *cached == m.id) {
            *engine = None;
        }
    }
    match &m.payload {
        // Archive models own their folder outright.
        Payload::Archive { .. } => {
            let dir = install_dir(m)?;
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
        }
        Payload::File { name, .. } => {
            let path = install_dir(m)?.join(name);
            if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Start one push-to-talk capture. Mic levels stream to `on_level` (coalesced
/// to ~30 fps off the audio thread). Fails if a capture is already live.
///
/// The permission is checked EXPLICITLY first: starting a CoreAudio stream
/// without it does not reliably fire the TCC prompt (dev builds in
/// particular) — the OS just delivers zeros. The AVCaptureDevice request is
/// what makes the prompt appear and the Settings entry exist.
#[tauri::command]
pub async fn voice_capture_start(
    on_level: Channel<f32>,
    state: tauri::State<'_, VoiceState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !tauri_plugin_macos_permissions::check_microphone_permission().await {
        request_microphone_access();
        return Err(
            "microphone permission is not granted. macOS attributes the request \
             to the app that LAUNCHED this process — if you started dev from \
             inside another app (including KeepDeck itself), that app must carry \
             NSMicrophoneUsageDescription or macOS denies silently. Launch dev \
             from a terminal once (the prompt will name the terminal), or allow \
             it in System Settings → Privacy & Security → Microphone, then hold \
             the key again"
                .into(),
        );
    }

    let mut slot = state.capture.lock().expect("poisoned");
    if slot.is_some() {
        return Err("a capture is already running".into());
    }

    let (cmd_tx, cmd_rx) = channel::<CaptureCmd>();
    let (out_tx, out_rx) = channel::<Option<(Vec<f32>, u32)>>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let (level_tx, level_rx) = keepdeck_voice::level_channel();

    // The recorder lives on this thread — cpal's stream is !Send. The OS mic
    // consent prompt fires on the first start.
    std::thread::spawn(move || {
        let recorder = match Recorder::start(Some(level_tx)) {
            Ok(r) => {
                let _ = ready_tx.send(Ok(()));
                r
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        match cmd_rx.recv() {
            Ok(CaptureCmd::Stop) => {
                let _ = out_tx.send(Some(recorder.stop()));
            }
            // Cancel or a dropped controller: discard the audio.
            _ => {
                let _ = out_tx.send(None);
            }
        }
    });

    // Level pump: coalesce the audio callback's readings to ~30 fps for the
    // webview meter; ends when the recorder (its sender) is dropped.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(33));
        let mut last = None;
        loop {
            match level_rx.try_recv() {
                Ok(v) => last = Some(v),
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
            }
        }
        if let Some(v) = last {
            let _ = on_level.send(v);
        }
    });

    ready_rx
        .recv()
        .map_err(|_| "capture thread died".to_string())??;
    *slot = Some(ActiveCapture { cmd_tx, out_rx });
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    text: String,
    /// True when the utterance was dropped as silence (whisper would have
    /// hallucinated on it) — the UI can say "didn't catch that".
    silence: bool,
    /// Captured length in seconds — 0.0 means the mic delivered nothing.
    seconds: f32,
    /// RMS level of the whole utterance. Persistently ~0 with a nonzero
    /// duration = the OS is delivering silence (mic permission).
    level: f32,
}

/// Stop the capture and transcribe it with `model`. `language` pins a
/// whisper code ("en", "ru"); absent = auto-detect. `prompt` biases whisper
/// vocabulary (workspace/branch names, command words) — parakeet detects its
/// 25 languages itself and takes no prompt.
#[tauri::command]
pub async fn voice_capture_stop(
    model: String,
    language: Option<String>,
    prompt: Option<String>,
    state: tauri::State<'_, VoiceState>,
) -> Result<TranscriptDto, String> {
    let m = spec(&model)?;
    let Some(load_path) = load_path(m)? else {
        // Still tear the capture down — the mic must not stay hot behind an
        // uninstalled-model error.
        let _ = take_capture(&state).map(|c| c.cmd_tx.send(CaptureCmd::Cancel));
        return Err(format!("voice model \"{model}\" is not downloaded"));
    };
    let capture = take_capture(&state)?;

    // Reuse the cached engine when it already holds this model.
    let cached = {
        let engine = state.engine.lock().expect("poisoned");
        engine
            .as_ref()
            .filter(|(id, _)| *id == m.id)
            .map(|(_, e)| e.clone())
    };

    let (transcript, engine_used) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(TranscriptDto, Option<(String, CachedEngine)>), String> {
            capture
                .cmd_tx
                .send(CaptureCmd::Stop)
                .map_err(|_| "capture thread died".to_string())?;
            let Some((samples, rate)) = capture
                .out_rx
                .recv()
                .map_err(|_| "capture thread died".to_string())?
            else {
                return Ok((
                    TranscriptDto {
                        text: String::new(),
                        silence: true,
                        seconds: 0.0,
                        level: 0.0,
                    },
                    None,
                ));
            };

            let samples = resample(&samples, rate, WHISPER_SAMPLE_RATE);
            let seconds = samples.len() as f32 / WHISPER_SAMPLE_RATE as f32;
            let level = rms(&samples);
            if is_silence(&samples) {
                return Ok((
                    TranscriptDto {
                        text: String::new(),
                        silence: true,
                        seconds,
                        level,
                    },
                    None,
                ));
            }

            let (engine, fresh) = match cached {
                Some(e) => (e, None),
                None => {
                    let e = match m.engine {
                        EngineType::Whisper => CachedEngine::Whisper(Arc::new(
                            WhisperEngine::load(&load_path).map_err(|e| e.to_string())?,
                        )),
                        EngineType::Parakeet => CachedEngine::Parakeet(Arc::new(Mutex::new(
                            ParakeetEngine::load(&load_path).map_err(|e| e.to_string())?,
                        ))),
                    };
                    (e.clone(), Some((m.id.to_string(), e)))
                }
            };
            let text = match &engine {
                CachedEngine::Whisper(whisper) => whisper
                    .transcribe(&samples, language.as_deref(), prompt.as_deref())
                    .map_err(|e| e.to_string())?,
                CachedEngine::Parakeet(parakeet) => parakeet
                    .lock()
                    .expect("poisoned")
                    .transcribe(&samples)
                    .map_err(|e| e.to_string())?,
            };
            Ok((
                TranscriptDto {
                    silence: text.is_empty(),
                    text,
                    seconds,
                    level,
                },
                fresh,
            ))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    if let Some(fresh) = engine_used {
        *state.engine.lock().expect("poisoned") = Some(fresh);
    }
    Ok(transcript)
}

/// Abandon the capture without transcribing (Escape during the hold).
#[tauri::command]
pub fn voice_capture_cancel(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    let capture = take_capture(&state)?;
    let _ = capture.cmd_tx.send(CaptureCmd::Cancel);
    Ok(())
}

/// Fire the AVCaptureDevice access request with a REAL completion block —
/// a nil completion handler (what the permissions plugin passes) fails to
/// raise the TCC dialog at least under a dev launch. The outcome lands in
/// the log so a granted/denied decision is visible without the Settings app.
#[cfg(target_os = "macos")]
fn request_microphone_access() {
    use block2::StackBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let media_type = NSString::from_str("soun");
    let handler = StackBlock::new(move |granted: Bool| {
        log::info!(
            "voice: microphone access request completed, granted={}",
            granted.as_bool()
        );
    })
    .copy();
    unsafe {
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: &*media_type,
            completionHandler: &*handler
        ];
    }
}

fn take_capture(state: &tauri::State<'_, VoiceState>) -> Result<ActiveCapture, String> {
    state
        .capture
        .lock()
        .expect("poisoned")
        .take()
        .ok_or_else(|| "no capture is running".to_string())
}
