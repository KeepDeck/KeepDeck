//! keepdeck-voice — local voice capture and speech-to-text.
//!
//! The pipeline is push-to-talk shaped: `Recorder` accumulates one utterance
//! (mono, native rate) while a key is held; on release the app resamples to
//! 16 kHz (`audio::resample`), drops silence (`audio::is_silence` — whisper
//! hallucinates on padded silence), and hands the samples to a cached
//! `WhisperEngine` for batch inference. Pure sample math lives in `audio`
//! and is unit-tested; the cpal and whisper wrappers stay thin.

pub mod audio;
pub mod capture;
pub mod engine;
pub mod parakeet;

pub use audio::{is_silence, mixdown, resample, rms, WHISPER_SAMPLE_RATE};
pub use capture::{level_channel, CaptureError, LevelSender, Recorder};
pub use engine::{EngineError, WhisperEngine};
pub use parakeet::ParakeetEngine;
