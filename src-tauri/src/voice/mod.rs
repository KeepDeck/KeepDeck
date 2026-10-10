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
    has_speech, input_devices, judge_hold, normalize_loudness, resample, rms, CaptureError,
    InputDevice, LevelReading, ParakeetEngine, Recorder, Recording, SilenceReason, WhisperEngine,
    WHISPER_SAMPLE_RATE,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::downloads;

mod capture_slot;
mod error;
mod permission;

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

/// One microphone on the wire — `SpeechDevice` in the plugin contract.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto {
    id: String,
    name: String,
    is_default: bool,
}

impl From<InputDevice> for DeviceDto {
    fn from(d: InputDevice) -> Self {
        DeviceDto {
            id: d.id,
            name: d.name,
            is_default: d.is_default,
        }
    }
}

/// The microphones the OS offers right now, default first. Read on request
/// — nothing watches for changes in the background.
#[tauri::command]
pub async fn voice_devices() -> Result<Vec<DeviceDto>, VoiceError> {
    tauri::async_runtime::spawn_blocking(input_devices)
        .await
        .map_err(|e| VoiceError::internal(e.to_string()))?
        .map(|devices| devices.into_iter().map(DeviceDto::from).collect())
        .map_err(VoiceError::from)
}

/// What a started capture is recording from — `SpeechCapture.device` /
/// `deviceMissing` in the contract.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartedDto {
    device: String,
    /// The caller asked for a device that is not connected; this capture is
    /// on the system default.
    device_missing: bool,
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
struct Cached<E> {
    id: String,
    engine: E,
    last_used: Instant,
}

type CachedModel = Cached<CachedEngine>;

/// The engine for `id`: the cached one when it is that model, otherwise a
/// fresh load — with the OLD model dropped BEFORE the new one loads
/// (decision №9). Holding both for the length of a load doubled the memory
/// (0.5–2 GB each) for nothing: the old one is never used again once
/// another is picked. A failed load leaves no model cached.
fn cached_or_load<E: Clone, Err>(
    slot: &mut Option<Cached<E>>,
    id: &str,
    load: impl FnOnce() -> Result<E, Err>,
) -> Result<E, Err> {
    if let Some(cached) = slot.as_ref().filter(|cached| cached.id == id) {
        return Ok(cached.engine.clone());
    }
    *slot = None;
    let engine = load()?;
    *slot = Some(Cached {
        id: id.to_owned(),
        engine: engine.clone(),
        last_used: Instant::now(),
    });
    Ok(engine)
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
/// to ~30 fps off the audio thread). Fails if a capture is already live, or
/// if the microphone permission is missing (see `permission`).
#[tauri::command]
pub async fn voice_capture_start(
    capture_id: String,
    plugin_id: String,
    session: String,
    device_id: Option<String>,
    on_level: Channel<LevelDto>,
    state: tauri::State<'_, VoiceState>,
) -> Result<StartedDto, VoiceError> {
    permission::ensure_microphone().await?;

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
    let (out_tx, out_rx) = channel::<Option<Recording>>();
    let (ready_tx, ready_rx) = channel::<Result<StartedDto, CaptureError>>();
    let (level_tx, level_rx) = keepdeck_voice::level_channel();

    // The recorder lives on this thread — cpal's stream is !Send. The OS mic
    // consent prompt fires on the first start.
    std::thread::spawn(move || {
        let recorder = match Recorder::start(device_id.as_deref(), Some(level_tx)) {
            Ok(r) => {
                let _ = ready_tx.send(Ok(StartedDto {
                    device: r.device().to_owned(),
                    device_missing: r.picked_missing(),
                }));
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
            let _ = on_level.send(LevelDto::from(v));
        }
    });

    // Opening the device takes as long as CoreAudio takes. The wait runs on
    // the blocking pool, never on an async worker (a parked worker stalls
    // every other command queued on it), and under NO lock: holding the
    // capture slot across it would serialize every other capture operation
    // behind a wait that has nothing to do with them.
    let opened = tauri::async_runtime::spawn_blocking(move || ready_rx.recv())
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
    Ok(opened)
}

/// One meter reading on the wire — `SpeechLevel` in the plugin contract.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LevelDto {
    rms: f32,
    peak: f32,
    clipped: bool,
    dc_offset: f32,
}

impl From<LevelReading> for LevelDto {
    fn from(r: LevelReading) -> Self {
        LevelDto {
            rms: r.rms,
            peak: r.peak,
            clipped: r.clipped,
            dc_offset: r.dc_offset,
        }
    }
}

/// What was measured over the whole hold — every transcript carries it,
/// spoken or not, so the caller can tell a dead mic from a distorted one.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct HoldFacts {
    /// Captured length in seconds — 0.0 means the mic delivered nothing.
    seconds: f32,
    /// RMS of the whole utterance after the offset is removed.
    level: f32,
    peak: f32,
    clipped_ratio: f32,
    dc_offset: f32,
    /// The device the audio came from, as the OS names it.
    device: String,
    /// The audio stopped arriving before the key was released.
    cut_short: bool,
}

/// `SilenceReason` on the wire — `SpeechSilenceReason` in the contract.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum SilenceReasonDto {
    NoAudio,
    DeadSignal,
    NoSpeech,
}

impl From<SilenceReason> for SilenceReasonDto {
    fn from(r: SilenceReason) -> Self {
        match r {
            SilenceReason::NoAudio => SilenceReasonDto::NoAudio,
            SilenceReason::DeadSignal => SilenceReasonDto::DeadSignal,
            SilenceReason::NoSpeech => SilenceReasonDto::NoSpeech,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    text: String,
    /// True when nothing was transcribed — the UI can say why from
    /// `silence_reason`.
    silence: bool,
    silence_reason: Option<SilenceReasonDto>,
    #[serde(flatten)]
    facts: HoldFacts,
}

impl TranscriptDto {
    fn silent(reason: SilenceReason, facts: HoldFacts) -> Self {
        TranscriptDto {
            text: String::new(),
            silence: true,
            silence_reason: Some(reason.into()),
            facts,
        }
    }

    /// The model's answer. Empty text over a hold with speech is still a
    /// silence — the model heard nothing it could write down.
    fn heard(text: String, facts: HoldFacts) -> Self {
        if text.is_empty() {
            return TranscriptDto::silent(SilenceReason::NoSpeech, facts);
        }
        TranscriptDto {
            text,
            silence: false,
            silence_reason: None,
            facts,
        }
    }
}

/// A finished hold, measured and judged: the 16 kHz samples for the model,
/// the facts every transcript carries, and why it is silent (if it is).
fn measure_hold(
    recording: Option<Recording>,
    held_seconds: f32,
) -> (Vec<f32>, HoldFacts, Option<SilenceReason>) {
    let recording = recording.unwrap_or_default();
    let utterance = recording.utterance;
    let samples = resample(
        &utterance.samples,
        utterance.sample_rate,
        WHISPER_SAMPLE_RATE,
    );
    let seconds = samples.len() as f32 / WHISPER_SAMPLE_RATE as f32;
    let speech = has_speech(&samples, WHISPER_SAMPLE_RATE);
    let judgment = judge_hold(held_seconds, seconds, utterance.peak, speech);
    let facts = HoldFacts {
        seconds,
        level: rms(&samples),
        peak: utterance.peak,
        clipped_ratio: utterance.clipped_ratio,
        dc_offset: utterance.dc_offset,
        device: recording.device,
        // The device saying it went away is the surest sign; a hold whose
        // audio fell short of its length is the fallback for one that does
        // not say.
        cut_short: judgment.cut_short || recording.lost,
    };
    (samples, facts, judgment.silence)
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
            let held_seconds = capture.started.elapsed().as_secs_f32();
            capture
                .cmd_tx
                .send(CaptureCmd::Stop)
                .map_err(|_| VoiceError::internal("capture thread died"))?;
            let recording = capture
                .out_rx
                .recv()
                .map_err(|_| VoiceError::internal("capture thread died"))?;
            let (samples, facts, silence) = measure_hold(recording, held_seconds);
            if let Some(reason) = silence {
                return Ok(TranscriptDto::silent(reason, facts));
            }
            // The model hears every utterance at one loudness, whatever the
            // input gain was; the facts above stay the raw measurements.
            let samples = normalize_loudness(&samples, WHISPER_SAMPLE_RATE);

            // The processing gate: one transcription at a time. A burst of
            // requests queues here instead of loading a second engine or
            // running two inferences on the one instance.
            let _turn = processing.lock().expect("poisoned");

            // Reuse the single cached engine, or load it (and cache it). The
            // engine lock is held through a load (seconds, rare) but never
            // across inference, so the reaper isn't blocked by a long
            // transcription.
            let engine = cached_or_load(
                &mut engine_slot.lock().expect("poisoned"),
                &cache_key,
                || -> Result<CachedEngine, VoiceError> {
                    Ok(match engine {
                        EngineType::Whisper => CachedEngine::Whisper(Arc::new(
                            WhisperEngine::load(&load_path).map_err(engine_error)?,
                        )),
                        EngineType::Parakeet => CachedEngine::Parakeet(Arc::new(Mutex::new(
                            ParakeetEngine::load(&load_path).map_err(engine_error)?,
                        ))),
                    })
                },
            )?;

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

            Ok(TranscriptDto::heard(text, facts))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The keys of one exported interface in `speech.ts`, in source order.
    fn ts_interface_keys(name: &str) -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/plugin-api/src/context/speech.ts");
        let source = std::fs::read_to_string(&path).expect("speech.ts is readable");
        let start = source
            .find(&format!("export interface {name} {{"))
            .unwrap_or_else(|| panic!("speech.ts declares {name}"));
        let body = &source[start..start + source[start..].find("\n}").unwrap()];
        body.lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.starts_with("/*") && !l.starts_with('*'))
            .filter_map(|l| l.split_once(':').map(|(k, _)| k.trim().to_owned()))
            .collect()
    }

    fn json_keys(value: serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    #[test]
    fn a_transcript_carries_exactly_the_contract_fields() {
        let wire = serde_json::to_value(TranscriptDto::silent(
            SilenceReason::NoSpeech,
            HoldFacts::default(),
        ))
        .unwrap();
        let mut ts = ts_interface_keys("SpeechTranscript");
        ts.sort();
        assert_eq!(json_keys(wire), ts);
    }

    #[test]
    fn a_device_carries_exactly_the_contract_fields() {
        let wire = serde_json::to_value(DeviceDto::from(InputDevice {
            id: "coreaudio:BuiltInMicrophoneDevice".into(),
            name: "MacBook Pro Microphone".into(),
            is_default: false,
        }))
        .unwrap();
        let mut ts = ts_interface_keys("SpeechDevice");
        ts.sort();
        assert_eq!(json_keys(wire), ts);
    }

    /// The string members of one exported union type in `speech.ts`.
    fn ts_union_members(name: &str) -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/plugin-api/src/context/speech.ts");
        let source = std::fs::read_to_string(&path).expect("speech.ts is readable");
        let start = source
            .find(&format!("export type {name} ="))
            .unwrap_or_else(|| panic!("speech.ts declares {name}"));
        let body = &source[start..start + source[start..].find(';').unwrap()];
        let mut members: Vec<String> = body
            .lines()
            .map(str::trim)
            .filter(|l| {
                l.starts_with('|') || l.contains('"') && !l.starts_with("/*") && !l.starts_with('*')
            })
            .filter_map(|l| l.split('"').nth(1).map(str::to_owned))
            .collect();
        members.sort();
        members
    }

    #[test]
    fn silence_reasons_match_the_contract_values() {
        let mut rust: Vec<String> = [
            SilenceReasonDto::NoAudio,
            SilenceReasonDto::DeadSignal,
            SilenceReasonDto::NoSpeech,
        ]
        .iter()
        .map(|r| {
            serde_json::to_value(r)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
        rust.sort();
        assert_eq!(rust, ts_union_members("SpeechSilenceReason"));
    }

    #[test]
    fn a_level_reading_carries_exactly_the_contract_fields() {
        let wire = serde_json::to_value(LevelDto::from(LevelReading::default())).unwrap();
        let mut ts = ts_interface_keys("SpeechLevel");
        ts.sort();
        assert_eq!(json_keys(wire), ts);
    }

    #[test]
    fn a_silent_transcript_still_reports_what_was_measured() {
        let facts = HoldFacts {
            seconds: 1.5,
            level: 0.0004,
            peak: 1.0,
            clipped_ratio: 0.02,
            dc_offset: 0.3,
            device: "BY-PM700".into(),
            cut_short: false,
        };
        let wire =
            serde_json::to_value(TranscriptDto::silent(SilenceReason::NoSpeech, facts)).unwrap();
        assert_eq!(wire["silence"], true);
        assert_eq!(wire["silenceReason"], "no-speech");
        assert_eq!(wire["device"], "BY-PM700");
        assert_eq!(wire["clippedRatio"].as_f64().unwrap() as f32, 0.02);
        assert_eq!(wire["dcOffset"].as_f64().unwrap() as f32, 0.3);
    }

    fn recording(samples: Vec<f32>, peak: f32) -> Option<Recording> {
        Some(Recording {
            device: "BY-PM700".into(),
            lost: false,
            utterance: keepdeck_voice::Utterance {
                samples,
                sample_rate: WHISPER_SAMPLE_RATE,
                peak,
                clipped_ratio: 0.0,
                dc_offset: 0.0,
            },
        })
    }

    #[test]
    fn a_hold_that_never_delivered_audio_is_no_audio() {
        let (_, facts, silence) = measure_hold(None, 2.0);
        assert_eq!(silence, Some(SilenceReason::NoAudio));
        assert_eq!(facts.seconds, 0.0);
    }

    #[test]
    fn digital_zero_from_the_os_is_a_dead_signal_and_names_the_device() {
        let (_, facts, silence) = measure_hold(recording(vec![0.0; 24_000], 0.0), 1.5);
        assert_eq!(silence, Some(SilenceReason::DeadSignal));
        assert_eq!(facts.device, "BY-PM700");
    }

    #[test]
    fn audio_that_stopped_partway_through_the_hold_is_cut_short() {
        // 1 s of audio (a phrase, then a pause), but the key was held 4 s.
        let tone: Vec<f32> = (0..16_000)
            .map(|i| {
                if i < 8_000 {
                    0.1 * (i as f32 * 0.12).sin()
                } else {
                    0.0005
                }
            })
            .collect();
        let (_, facts, silence) = measure_hold(recording(tone, 0.1), 4.0);
        assert_eq!(silence, None);
        assert!(facts.cut_short);
    }

    #[test]
    fn a_device_that_reported_itself_gone_cuts_the_hold_short() {
        // The audio covers the hold, but the device said it went away.
        let tone: Vec<f32> = (0..32_000)
            .map(|i| {
                if i < 16_000 {
                    0.1 * (i as f32 * 0.12).sin()
                } else {
                    0.0005
                }
            })
            .collect();
        let mut lost = recording(tone, 0.1).unwrap();
        lost.lost = true;
        let (_, facts, _) = measure_hold(Some(lost), 2.0);
        assert!(facts.cut_short);
    }

    #[test]
    fn switching_models_drops_the_old_one_before_loading_the_new() {
        let old = Arc::new("whisper");
        let watch = Arc::downgrade(&old);
        let mut slot = Some(Cached {
            id: "whisper".to_owned(),
            engine: old,
            last_used: Instant::now(),
        });
        let loaded = cached_or_load(&mut slot, "parakeet", || -> Result<_, ()> {
            assert!(
                watch.upgrade().is_none(),
                "the old model is still in memory while the new one loads"
            );
            Ok(Arc::new("parakeet"))
        })
        .unwrap();
        assert_eq!(*loaded, "parakeet");
        assert_eq!(slot.as_ref().unwrap().id, "parakeet");
    }

    #[test]
    fn the_same_model_is_reused_without_a_load() {
        let mut slot = Some(Cached {
            id: "parakeet".to_owned(),
            engine: Arc::new("parakeet"),
            last_used: Instant::now(),
        });
        let reused = cached_or_load(&mut slot, "parakeet", || -> Result<Arc<&str>, ()> {
            panic!("no load for the cached model")
        });
        assert_eq!(*reused.unwrap(), "parakeet");
    }

    #[test]
    fn a_failed_load_leaves_no_model_cached() {
        let mut slot = Some(Cached {
            id: "whisper".to_owned(),
            engine: Arc::new("whisper"),
            last_used: Instant::now(),
        });
        let failed = cached_or_load(&mut slot, "parakeet", || Err::<Arc<&str>, _>("bad model"));
        assert_eq!(failed.unwrap_err(), "bad model");
        assert!(slot.is_none());
    }

    #[test]
    fn the_model_hearing_nothing_is_a_no_speech_silence() {
        let t = TranscriptDto::heard(String::new(), HoldFacts::default());
        assert!(t.silence);
        assert_eq!(t.silence_reason, Some(SilenceReasonDto::NoSpeech));
        let t = TranscriptDto::heard("hello".into(), HoldFacts::default());
        assert!(!t.silence);
        assert_eq!(t.silence_reason, None);
    }
}
