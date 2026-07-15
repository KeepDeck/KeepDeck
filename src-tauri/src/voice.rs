//! Native speech delivery over `keepdeck-voice`: one push-to-talk capture and
//! batch transcription against a caller-provided engine + private model path.
//! Model catalogs, URLs, installation and deletion deliberately live outside.
//!
//! cpal's input stream is !Send, so a capture runs on its own thread that
//! OWNS the recorder; the managed state holds only the channels that command
//! it. The loaded whisper context is cached per model path — loading
//! large-v3-turbo takes seconds and must not happen per utterance.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keepdeck_voice::{is_silence, resample, rms, Recorder, WhisperEngine, WHISPER_SAMPLE_RATE};
// Parakeet is Apple-Silicon only (its ONNX runtime has no Intel-macOS binary).
#[cfg(target_arch = "aarch64")]
use keepdeck_voice::ParakeetEngine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::downloads;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum EngineType {
    Whisper,
    #[cfg(target_arch = "aarch64")]
    Parakeet,
}

#[tauri::command]
pub fn voice_engines() -> Vec<&'static str> {
    let mut engines = vec!["whisper"];
    #[cfg(target_arch = "aarch64")]
    engines.push("parakeet");
    engines
}

fn resolve_model_path(plugin_id: &str, relative: &str) -> Result<PathBuf, String> {
    downloads::target_path(&format!("plugins/{plugin_id}/{relative}"))
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
    #[cfg(target_arch = "aarch64")]
    Parakeet(Arc<Mutex<ParakeetEngine>>),
}

impl Clone for CachedEngine {
    fn clone(&self) -> Self {
        match self {
            CachedEngine::Whisper(e) => CachedEngine::Whisper(e.clone()),
            #[cfg(target_arch = "aarch64")]
            CachedEngine::Parakeet(e) => CachedEngine::Parakeet(e.clone()),
        }
    }
}

/// The ONE loaded engine, with the model it holds and when it was last used.
struct CachedModel {
    id: String,
    engine: CachedEngine,
    last_used: Instant,
}

/// Drop the loaded engine after this long unused. A large model (turbo,
/// parakeet) is 0.5–2 GB resident; nobody expects the app to hold that after
/// a morning's dictation. Reloading on the next utterance costs a few seconds.
const ENGINE_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct VoiceState {
    capture: Mutex<Option<ActiveCapture>>,
    /// At most ONE engine instance, shared with the idle-reaper thread.
    engine: Arc<Mutex<Option<CachedModel>>>,
    /// Serializes transcription: one utterance is processed at a time and the
    /// rest queue on this lock, so rapid-fire requests never spin up a second
    /// inference on the single engine.
    processing: Arc<Mutex<()>>,
    /// Whether the idle-reaper thread is running (spawned once, on first load).
    reaper: Arc<AtomicBool>,
}

/// Start the idle reaper once: every 30s it drops the cached engine if it has
/// gone `ENGINE_IDLE_TIMEOUT` unused, freeing the model's memory.
fn ensure_reaper(state: &VoiceState) {
    if state.reaper.swap(true, Ordering::SeqCst) {
        return;
    }
    let engine = state.engine.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let mut slot = engine.lock().expect("poisoned");
        let idle = slot
            .as_ref()
            .is_some_and(|m| m.last_used.elapsed() >= ENGINE_IDLE_TIMEOUT);
        if idle {
            *slot = None;
        }
    });
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

/// Stop the capture and transcribe it with the caller's engine + model path. `language` pins a
/// whisper code ("en", "ru"); absent = auto-detect. `prompt` biases whisper
/// vocabulary (workspace/branch names, command words) — parakeet detects its
/// 25 languages itself and takes no prompt.
#[tauri::command]
pub async fn voice_capture_stop(
    plugin_id: String,
    engine: EngineType,
    model_path: String,
    language: Option<String>,
    prompt: Option<String>,
    state: tauri::State<'_, VoiceState>,
) -> Result<TranscriptDto, String> {
    let load_path = resolve_model_path(&plugin_id, &model_path)?;
    if !load_path.exists() {
        // Still tear the capture down — the mic must not stay hot behind an
        // uninstalled-model error.
        let _ = take_capture(&state).map(|c| c.cmd_tx.send(CaptureCmd::Cancel));
        return Err("speech model is not downloaded".into());
    }
    let cache_key = format!("{engine:?}:{}", load_path.display());
    let capture = take_capture(&state)?;
    ensure_reaper(&state);
    let engine_slot = state.engine.clone();
    let processing = state.processing.clone();

    let transcript =
        tauri::async_runtime::spawn_blocking(move || -> Result<TranscriptDto, String> {
            capture
                .cmd_tx
                .send(CaptureCmd::Stop)
                .map_err(|_| "capture thread died".to_string())?;
            let Some((samples, rate)) = capture
                .out_rx
                .recv()
                .map_err(|_| "capture thread died".to_string())?
            else {
                return Ok(TranscriptDto {
                    text: String::new(),
                    silence: true,
                    seconds: 0.0,
                    level: 0.0,
                });
            };

            let samples = resample(&samples, rate, WHISPER_SAMPLE_RATE);
            let seconds = samples.len() as f32 / WHISPER_SAMPLE_RATE as f32;
            let level = rms(&samples);
            if is_silence(&samples) {
                return Ok(TranscriptDto {
                    text: String::new(),
                    silence: true,
                    seconds,
                    level,
                });
            }

            // The processing gate: one transcription at a time. A burst of
            // requests queues here instead of loading a second engine or
            // running two inferences on the one instance.
            let _turn = processing.lock().expect("poisoned");

            // Reuse the single cached engine, or load it (and cache it) —
            // holding the engine lock only around the swap, never across
            // inference, so `delete` and the reaper aren't blocked by a long
            // transcription.
            let engine = {
                let mut slot = engine_slot.lock().expect("poisoned");
                let reusable = slot
                    .as_ref()
                    .filter(|cached| cached.id == cache_key)
                    .map(|cached| cached.engine.clone());
                match reusable {
                    Some(e) => e,
                    None => {
                        let e = match engine {
                            EngineType::Whisper => CachedEngine::Whisper(Arc::new(
                                WhisperEngine::load(&load_path).map_err(|e| e.to_string())?,
                            )),
                            #[cfg(target_arch = "aarch64")]
                            EngineType::Parakeet => CachedEngine::Parakeet(Arc::new(Mutex::new(
                                ParakeetEngine::load(&load_path).map_err(|e| e.to_string())?,
                            ))),
                        };
                        *slot = Some(CachedModel {
                            id: cache_key.clone(),
                            engine: e.clone(),
                            last_used: Instant::now(),
                        });
                        e
                    }
                }
            };

            let text = match &engine {
                CachedEngine::Whisper(whisper) => whisper
                    .transcribe(&samples, language.as_deref(), prompt.as_deref())
                    .map_err(|e| e.to_string())?,
                #[cfg(target_arch = "aarch64")]
                CachedEngine::Parakeet(parakeet) => parakeet
                    .lock()
                    .expect("poisoned")
                    .transcribe(&samples)
                    .map_err(|e| e.to_string())?,
            };

            // Mark it fresh so the reaper measures idle from the LAST use, not
            // from load. A model deleted mid-transcription won't be re-cached.
            if let Some(cached) = engine_slot
                .lock()
                .expect("poisoned")
                .as_mut()
                .filter(|cached| cached.id == cache_key)
            {
                cached.last_used = Instant::now();
            }

            Ok(TranscriptDto {
                silence: text.is_empty(),
                text,
                seconds,
                level,
            })
        })
        .await
        .map_err(|e| e.to_string())??;

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
