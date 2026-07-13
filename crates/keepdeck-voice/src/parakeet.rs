//! Parakeet TDT inference (ONNX Runtime, CPU). The second engine behind the
//! same batch-on-release shape as whisper: 16 kHz mono in, text out. The
//! model auto-detects its 25 languages and emits punctuation itself — there
//! is no language pin and no vocabulary prompt on this path.

use std::path::Path;

use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};

use crate::engine::EngineError;

pub struct ParakeetEngine {
    model: ParakeetTDT,
}

impl ParakeetEngine {
    /// Load from a model DIRECTORY holding the istupakov ONNX export
    /// (`vocab.txt`, `nemo128.onnx`, `encoder-model.int8.onnx`,
    /// `decoder_joint-model.int8.onnx`).
    pub fn load(model_dir: &Path) -> Result<Self, EngineError> {
        let model = ParakeetTDT::from_pretrained(model_dir, None)
            .map_err(|e| EngineError(e.to_string()))?;
        Ok(ParakeetEngine { model })
    }

    /// Transcribe one 16 kHz mono utterance. `&mut` is the crate's contract
    /// (decoder state lives in the model); the caller serializes access.
    pub fn transcribe(&mut self, samples_16k: &[f32]) -> Result<String, EngineError> {
        let result = self
            .model
            .transcribe_samples(
                samples_16k.to_vec(),
                16_000,
                1,
                // TDT predicts punctuation — sentence mode keeps it natural.
                Some(TimestampMode::Sentences),
            )
            .map_err(|e| EngineError(e.to_string()))?;
        Ok(result.text.trim().to_string())
    }
}
