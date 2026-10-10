//! The one error every voice command rejects with: `{ kind, message }`.

use keepdeck_voice::CaptureError;
use serde::Serialize;

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
    pub(super) kind: VoiceErrorKind,
    message: String,
}

impl VoiceError {
    pub(super) fn new(kind: VoiceErrorKind, message: impl Into<String>) -> Self {
        VoiceError {
            kind,
            message: message.into(),
        }
    }

    pub(super) fn internal(message: impl Into<String>) -> Self {
        VoiceError::new(VoiceErrorKind::Internal, message)
    }

    /// How a taken capture slot is reported — one wording for every place
    /// that finds it taken.
    pub(super) fn busy() -> Self {
        VoiceError::new(VoiceErrorKind::Busy, "a capture is already running")
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

#[cfg(test)]
mod tests {
    use super::*;

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
            .map(|k| {
                serde_json::to_value(k)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        ts.sort();
        rust.sort();
        assert_eq!(rust, ts);
    }
}
