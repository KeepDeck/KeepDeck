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

use keepdeck_voice::{
    is_silence, resample, rms, CaptureError, ParakeetEngine, Recorder, WhisperEngine,
    WHISPER_SAMPLE_RATE,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::downloads;

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
    downloads::target_path(&format!("plugins/{plugin_id}/{relative}"))
        .map_err(VoiceError::internal)
}

// ----------------------------------------------------------------- errors --

/// What went wrong, as a kind the caller can act on — the message alone is
/// prose for a human. Serialized kebab-case; the same list is the
/// `SpeechErrorKind` union in `@keepdeck/plugin-api` (a test below holds the
/// two together).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceErrorKind {
    /// macOS has not granted the microphone.
    Permission,
    /// No input device to record from.
    NoDevice,
    /// The device failed to open or the stream failed.
    Device,
    /// The device delivers a sample format capture cannot read.
    UnsupportedFormat,
    /// Another capture holds the single capture slot.
    Busy,
    /// The handle names no running capture (closed, or someone else's).
    NoCapture,
    /// The model the caller asked for is not on disk.
    ModelMissing,
    /// The speech engine failed to load the model or to transcribe.
    Engine,
    /// A capture thread or task died — a bug, not a user condition.
    Internal,
}

impl VoiceErrorKind {
    /// Every kind — a new variant fails the match below until it is listed.
    #[cfg(test)]
    const ALL: [VoiceErrorKind; 9] = [
        VoiceErrorKind::Permission,
        VoiceErrorKind::NoDevice,
        VoiceErrorKind::Device,
        VoiceErrorKind::UnsupportedFormat,
        VoiceErrorKind::Busy,
        VoiceErrorKind::NoCapture,
        VoiceErrorKind::ModelMissing,
        VoiceErrorKind::Engine,
        VoiceErrorKind::Internal,
    ];

    #[cfg(test)]
    #[allow(dead_code)]
    fn listed_in_all(self) {
        match self {
            VoiceErrorKind::Permission
            | VoiceErrorKind::NoDevice
            | VoiceErrorKind::Device
            | VoiceErrorKind::UnsupportedFormat
            | VoiceErrorKind::Busy
            | VoiceErrorKind::NoCapture
            | VoiceErrorKind::ModelMissing
            | VoiceErrorKind::Engine
            | VoiceErrorKind::Internal => {}
        }
    }
}

/// The error every voice command rejects with: `{ kind, message }` on the
/// wire.
#[derive(Debug, Serialize)]
pub struct VoiceError {
    kind: VoiceErrorKind,
    message: String,
}

impl VoiceError {
    fn new(kind: VoiceErrorKind, message: impl Into<String>) -> Self {
        VoiceError {
            kind,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        VoiceError::new(VoiceErrorKind::Internal, message)
    }

    fn busy() -> Self {
        VoiceError::new(VoiceErrorKind::Busy, CAPTURE_BUSY)
    }
}

impl From<CaptureError> for VoiceError {
    fn from(e: CaptureError) -> Self {
        let kind = match e {
            CaptureError::NoInputDevice => VoiceErrorKind::NoDevice,
            CaptureError::UnsupportedFormat(_) => VoiceErrorKind::UnsupportedFormat,
            CaptureError::Device(_) => VoiceErrorKind::Device,
        };
        VoiceError::new(kind, e.to_string())
    }
}

// ---------------------------------------------------------------- capture --

enum CaptureCmd {
    Stop,
    Cancel,
}

struct ActiveCapture {
    id: String,
    plugin_id: String,
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

/// How a taken capture slot is reported — one wording for the fast-path check
/// and the claim, so the two can never drift apart.
const CAPTURE_BUSY: &str = "a capture is already running";

impl VoiceState {
    /// Whether a capture holds the slot right now.
    fn is_capturing(&self) -> bool {
        self.capture.lock().expect("poisoned").is_some()
    }

    /// Claim the single capture slot. A taken slot hands the capture BACK
    /// instead of dropping it: it owns a live recorder holding the
    /// microphone, and the caller that built it is the only one that can
    /// still tear it down.
    fn claim(&self, capture: ActiveCapture) -> Result<(), ActiveCapture> {
        let mut slot = self.capture.lock().expect("poisoned");
        if slot.is_some() {
            return Err(capture);
        }
        *slot = Some(capture);
        Ok(())
    }
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

    if capture_id.trim().is_empty() {
        return Err(VoiceError::internal("capture id must not be empty"));
    }
    // The fast path only: a start that is obviously doomed fails before it
    // opens a device. The slot is not RESERVED here — `claim` below is the
    // authority, because the lock is deliberately not held across the wait.
    if state.is_capturing() {
        return Err(VoiceError::busy());
    }

    let (cmd_tx, cmd_rx) = channel::<CaptureCmd>();
    let (out_tx, out_rx) = channel::<Option<(Vec<f32>, u32)>>();
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

    // Opening the device takes as long as CoreAudio takes. This wait runs
    // under NO lock: holding the capture slot across it would park a tokio
    // worker and serialize every other capture operation behind a wait that
    // has nothing to do with them.
    ready_rx
        .recv()
        .map_err(|_| VoiceError::internal("capture thread died"))??;
    if let Err(orphan) = state.claim(ActiveCapture {
        id: capture_id,
        plugin_id,
        cmd_tx,
        out_rx,
    }) {
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
    let capture = take_capture(&state, &capture_id)?;
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
            let Some((samples, rate)) = capture
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
    let capture = take_capture(&state, &capture_id)?;
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

fn take_capture(state: &VoiceState, capture_id: &str) -> Result<ActiveCapture, VoiceError> {
    let mut slot = state.capture.lock().expect("poisoned");
    match slot.as_ref() {
        Some(capture) if capture.id == capture_id => {
            Ok(slot.take().expect("capture checked above"))
        }
        Some(_) => Err(VoiceError::new(
            VoiceErrorKind::NoCapture,
            "speech capture does not belong to this handle",
        )),
        None => Err(VoiceError::new(
            VoiceErrorKind::NoCapture,
            "no capture is running",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A capture plus the command receiver its recorder thread would hold, so
    /// a send on the capture proves the recorder is still reachable.
    fn capture(id: &str) -> (ActiveCapture, Receiver<CaptureCmd>) {
        let (cmd_tx, cmd_rx) = channel();
        let (_out_tx, out_rx) = channel();
        (
            ActiveCapture {
                id: id.into(),
                plugin_id: "plugin-a".into(),
                cmd_tx,
                out_rx,
            },
            cmd_rx,
        )
    }

    #[test]
    fn a_losing_claim_hands_its_capture_back_so_the_device_can_be_released() {
        let state = VoiceState::default();
        let (first, _first_cmds) = capture("capture-a");
        let (second, second_cmds) = capture("capture-b");

        assert!(!state.is_capturing());
        assert!(state.claim(first).is_ok(), "the slot was free");
        assert!(state.is_capturing());

        // The slot was taken while this capture's device was opening. It must
        // come back to its builder — dropping it here would strand a live
        // recorder on the microphone with nothing left to cancel it.
        let orphan = match state.claim(second) {
            Ok(()) => panic!("the slot was already taken"),
            Err(orphan) => orphan,
        };
        assert_eq!(orphan.id, "capture-b");
        orphan
            .cmd_tx
            .send(CaptureCmd::Cancel)
            .expect("the returned capture can still be torn down");
        assert!(matches!(second_cmds.recv(), Ok(CaptureCmd::Cancel)));

        // The winner keeps the slot.
        assert_eq!(
            state.capture.lock().unwrap().as_ref().unwrap().id,
            "capture-a"
        );
    }

    #[test]
    fn a_voice_error_crosses_the_wire_as_kind_and_message() {
        let wire = serde_json::to_value(VoiceError::new(
            VoiceErrorKind::ModelMissing,
            "speech model is not downloaded",
        ))
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "kind": "model-missing",
                "message": "speech model is not downloaded",
            })
        );
    }

    #[test]
    fn capture_failures_keep_their_kind() {
        let kind = |e: CaptureError| VoiceError::from(e).kind;
        assert_eq!(kind(CaptureError::NoInputDevice), VoiceErrorKind::NoDevice);
        assert_eq!(
            kind(CaptureError::UnsupportedFormat("U8".into())),
            VoiceErrorKind::UnsupportedFormat
        );
        assert_eq!(
            kind(CaptureError::Device("gone".into())),
            VoiceErrorKind::Device
        );
    }

    /// The kinds are a contract with `@keepdeck/plugin-api`: a kind added or
    /// renamed on one side and not the other breaks a plugin's `switch`
    /// silently, so the two lists are held equal here.
    #[test]
    fn error_kinds_match_the_plugin_api_contract() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/plugin-api/src/context/speech.ts");
        let source = std::fs::read_to_string(&path).expect("speech.ts is readable");
        let start = source
            .find("export const SPEECH_ERROR_KINDS = [")
            .expect("speech.ts declares SPEECH_ERROR_KINDS");
        let list = &source[start..start + source[start..].find("]").unwrap()];
        let mut ts: Vec<String> = list
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect();
        let mut rust: Vec<String> = VoiceErrorKind::ALL
            .iter()
            .map(|k| serde_json::to_value(k).unwrap().as_str().unwrap().to_owned())
            .collect();
        ts.sort();
        rust.sort();
        assert_eq!(rust, ts);
    }

    #[test]
    fn capture_handle_cannot_take_another_capture() {
        let state = VoiceState::default();
        let (cmd_tx, _cmd_rx) = channel();
        let (_out_tx, out_rx) = channel();
        *state.capture.lock().unwrap() = Some(ActiveCapture {
            id: "capture-a".into(),
            plugin_id: "plugin-a".into(),
            cmd_tx,
            out_rx,
        });

        assert!(matches!(
            take_capture(&state, "capture-b"),
            Err(VoiceError { kind: VoiceErrorKind::NoCapture, .. })
        ));
        assert!(state.capture.lock().unwrap().is_some());
        assert_eq!(
            take_capture(&state, "capture-a").unwrap().plugin_id,
            "plugin-a"
        );
        assert!(state.capture.lock().unwrap().is_none());
    }
}
