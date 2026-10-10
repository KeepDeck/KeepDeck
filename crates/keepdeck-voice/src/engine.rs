//! whisper.cpp inference. One `WhisperEngine` wraps one loaded model; the
//! app layer caches it per model path (loading large-v3-turbo takes seconds
//! — it must not happen per utterance).

use std::path::Path;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct WhisperEngine {
    ctx: WhisperContext,
}

/// A speech engine failed to load a model or to transcribe — named by the
/// engine it came from, so a Parakeet failure never reads as whisper's.
#[derive(Debug)]
pub struct EngineError {
    engine: &'static str,
    message: String,
}

impl EngineError {
    pub fn whisper(message: impl std::fmt::Display) -> Self {
        EngineError {
            engine: "whisper",
            message: message.to_string(),
        }
    }

    pub fn parakeet(message: impl std::fmt::Display) -> Self {
        EngineError {
            engine: "parakeet",
            message: message.to_string(),
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.engine, self.message)
    }
}

impl std::error::Error for EngineError {}

impl WhisperEngine {
    pub fn load(model_path: &Path) -> Result<Self, EngineError> {
        let path = model_path
            .to_str()
            .ok_or_else(|| EngineError::whisper("model path is not valid UTF-8"))?;
        let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(EngineError::whisper)?;
        Ok(WhisperEngine { ctx })
    }

    /// Transcribe one 16 kHz mono utterance. `language` is a whisper code
    /// ("en", "ru") or None for auto-detect; `prompt` biases recognition
    /// toward known vocabulary (workspace and branch names, command words) —
    /// the standard fix for technical terms.
    pub fn transcribe(
        &self,
        samples_16k: &[f32],
        language: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<String, EngineError> {
        let mut state = self.ctx.create_state().map_err(EngineError::whisper)?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_translate(false);
        params.set_language(language);
        if let Some(p) = prompt {
            params.set_initial_prompt(p);
        }
        // A utility transcriber, not a subtitle tool: no live printing.
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);

        state
            .full(params, samples_16k)
            .map_err(EngineError::whisper)?;

        let segments = state.full_n_segments();
        let mut text = String::new();
        for i in 0..segments {
            let Some(segment) = state.get_segment(i) else {
                continue;
            };
            text.push_str(&segment.to_str_lossy().map_err(EngineError::whisper)?);
        }
        Ok(text.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_engine_failure_names_its_own_engine() {
        assert_eq!(
            EngineError::whisper("bad file").to_string(),
            "whisper: bad file"
        );
        assert_eq!(
            EngineError::parakeet("bad file").to_string(),
            "parakeet: bad file"
        );
    }
}
