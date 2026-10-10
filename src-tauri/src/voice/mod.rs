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
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keepdeck_voice::{
    has_speech, resample, rms, CaptureError, ParakeetEngine, Recorder, Utterance, WhisperEngine,
    WHISPER_SAMPLE_RATE,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::downloads;

mod capture_slot;
mod error;

use capture_slot::{ActiveCapture, CaptureCmd, CaptureSlot, MAX_CAPTURE};
pub use error::VoiceError;
use error::VoiceErrorKind;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum EngineType {
    Whisper,
    Parakeet,
}

#[tauri::command]
pub fn voice_engines() -> Vec<&'static str> {
    vec!["whisper", "parakeet"]
}

fn resolve_model_path(plugin_id: &str, relative: &str) -> Result<PathBuf, VoiceError> {
    downloads::target_path(&format!("plugins/{plugin_id}/{relative}")).map_err(VoiceError::internal)
}

// ---------------------------------------------------------------- capture --

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
    capture: CaptureSlot,
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
    capture_id: String,
    plugin_id: String,
    session: String,
    on_level: Channel<f32>,
    state: tauri::State<'_, VoiceState>,
) -> Result<(), VoiceError> {
    #[cfg(target_os = "macos")]
    if !tauri_plugin_macos_permissions::check_microphone_permission().await {
        request_microphone_access();
        return Err(VoiceError::new(
            VoiceErrorKind::Permission,
            "microphone permission is not granted. macOS attributes the request \
             to the app that LAUNCHED this process — if you started dev from \
             inside another app (including KeepDeck itself), that app must carry \
             NSMicrophoneUsageDescription or macOS denies silently. Launch dev \
             from a terminal once (the prompt will name the terminal), or allow \
             it in System Settings → Privacy & Security → Microphone, then hold \
             the key again",
        ));
    }

    if capture_id.trim().is_empty() || session.trim().is_empty() {
        return Err(VoiceError::internal(
            "capture id and session must not be empty",
        ));
    }
    // The fast path only: a start that is obviously doomed fails before it
    // opens a device. The slot is not RESERVED here — `claim` below is the
    // authority, because the lock is deliberately not held across the wait.
    if state.capture.is_busy(&session, Instant::now()) {
        return Err(VoiceError::busy());
    }

    let started = Instant::now();
    let (cmd_tx, cmd_rx) = channel::<CaptureCmd>();
    let (out_tx, out_rx) = channel::<Option<Utterance>>();
    let (ready_tx, ready_rx) = channel::<Result<(), CaptureError>>();
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
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        match cmd_rx.recv_timeout(MAX_CAPTURE) {
            Ok(CaptureCmd::Stop) => {
                let _ = out_tx.send(Some(recorder.stop()));
            }
            // Cancel, a dropped controller, or a hold past MAX_CAPTURE that
            // nobody ended: discard the audio and release the microphone.
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
            let _ = on_level.send(v.rms);
        }
    });

    // Opening the device takes as long as CoreAudio takes. The wait runs on
    // the blocking pool, never on an async worker (a parked worker stalls
    // every other command queued on it), and under NO lock: holding the
    // capture slot across it would serialize every other capture operation
    // behind a wait that has nothing to do with them.
    tauri::async_runtime::spawn_blocking(move || ready_rx.recv())
        .await
        .map_err(|e| VoiceError::internal(e.to_string()))?
        .map_err(|_| VoiceError::internal("capture thread died"))??;
    if let Err(orphan) = state.capture.claim(
        ActiveCapture {
            id: capture_id,
            plugin_id,
            session,
            started,
            cmd_tx,
            out_rx,
        },
        Instant::now(),
    ) {
        // Another start claimed the slot while this one was opening its
        // device. Discard OUR recorder — an unclaimed capture still holds the
        // microphone, and nothing else knows about it to release it later.
        let _ = orphan.cmd_tx.send(CaptureCmd::Cancel);
        return Err(VoiceError::busy());
    }
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
    capture_id: String,
    engine: EngineType,
    model_path: String,
    language: Option<String>,
    prompt: Option<String>,
    state: tauri::State<'_, VoiceState>,
) -> Result<TranscriptDto, VoiceError> {
    let capture = state.capture.take(&capture_id)?;
    let load_path = resolve_model_path(&capture.plugin_id, &model_path)?;
    if !load_path.exists() {
        // Still tear the capture down — the mic must not stay hot behind an
        // uninstalled-model error.
        let _ = capture.cmd_tx.send(CaptureCmd::Cancel);
        return Err(VoiceError::new(
            VoiceErrorKind::ModelMissing,
            "speech model is not downloaded",
        ));
    }
    let cache_key = format!("{engine:?}:{}", load_path.display());
    ensure_reaper(&state);
    let engine_slot = state.engine.clone();
    let processing = state.processing.clone();

    let transcript =
        tauri::async_runtime::spawn_blocking(move || -> Result<TranscriptDto, VoiceError> {
            capture
                .cmd_tx
                .send(CaptureCmd::Stop)
                .map_err(|_| VoiceError::internal("capture thread died"))?;
            let Some(utterance) = capture
                .out_rx
                .recv()
                .map_err(|_| VoiceError::internal("capture thread died"))?
            else {
                return Ok(TranscriptDto {
                    text: String::new(),
                    silence: true,
                    seconds: 0.0,
                    level: 0.0,
                });
            };

            let samples = resample(
                &utterance.samples,
                utterance.sample_rate,
                WHISPER_SAMPLE_RATE,
            );
            let seconds = samples.len() as f32 / WHISPER_SAMPLE_RATE as f32;
            let level = rms(&samples);
            if !has_speech(&samples, WHISPER_SAMPLE_RATE) {
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
                                WhisperEngine::load(&load_path).map_err(engine_error)?,
                            )),
                            EngineType::Parakeet => CachedEngine::Parakeet(Arc::new(Mutex::new(
                                ParakeetEngine::load(&load_path).map_err(engine_error)?,
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
                    .map_err(engine_error)?,
                CachedEngine::Parakeet(parakeet) => parakeet
                    .lock()
                    .expect("poisoned")
                    .transcribe(&samples)
                    .map_err(engine_error)?,
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
        .map_err(|e| VoiceError::internal(e.to_string()))??;

    Ok(transcript)
}

fn engine_error(e: impl std::fmt::Display) -> VoiceError {
    VoiceError::new(VoiceErrorKind::Engine, e.to_string())
}

/// Abandon the capture without transcribing (Escape during the hold).
#[tauri::command]
pub fn voice_capture_cancel(
    capture_id: String,
    state: tauri::State<'_, VoiceState>,
) -> Result<(), VoiceError> {
    let capture = state.capture.take(&capture_id)?;
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
