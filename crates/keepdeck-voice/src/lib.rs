//! keepdeck-voice — local voice capture and speech-to-text.
//!
//! The pipeline is push-to-talk shaped: `Recorder` conditions and accumulates
//! one utterance while a key is held (`signal`: offset removed, loudest
//! channel kept, peak/clipping/offset measured); on release the app resamples
//! to 16 kHz (`audio::resample`), drops holds with no speech
//! (`audio::has_speech` — whisper hallucinates on padded silence), and hands
//! the samples to a cached engine for batch inference. Pure sample math lives
//! in `audio` and `signal` and is unit-tested; the cpal and engine wrappers
//! stay thin.

pub mod audio;
pub mod capture;
pub mod engine;
pub mod hold;
pub mod parakeet;
pub mod signal;

pub use audio::{has_speech, normalize_loudness, resample, rms, WHISPER_SAMPLE_RATE};
pub use capture::{level_channel, CaptureError, LevelSender, Recorder, Recording};
pub use engine::{EngineError, WhisperEngine};
pub use hold::{judge_hold, HoldJudgment, SilenceReason};
pub use parakeet::ParakeetEngine;
pub use signal::{LevelReading, Utterance};
