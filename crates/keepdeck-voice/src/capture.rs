//! Microphone capture. One `Recorder` owns one cpal input stream on the
//! default device; samples are mixed to mono at the device's native rate and
//! accumulated until `stop()`, which hands back the whole utterance —
//! push-to-talk bounds the recording, so batch-on-release needs no ring
//! buffer or VAD chunking here.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};

use crate::audio::mixdown;

/// Coarse mic level per callback, for a live indicator. Sent best-effort —
/// a full channel drops the newest reading rather than blocking the
/// REALTIME audio thread.
pub type LevelSender = Sender<f32>;

pub struct Recorder {
    // cpal's Stream is deliberately !Send; keeping it alive keeps capture
    // running, dropping it stops the device.
    stream: Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
}

#[derive(Debug)]
pub enum CaptureError {
    NoInputDevice,
    UnsupportedFormat(String),
    Device(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::NoInputDevice => write!(f, "no microphone input device"),
            CaptureError::UnsupportedFormat(s) => {
                write!(f, "unsupported input sample format: {s}")
            }
            CaptureError::Device(s) => write!(f, "microphone error: {s}"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl Recorder {
    /// Open the default input device and start capturing. The OS microphone
    /// consent prompt (macOS TCC) fires on the first stream start.
    pub fn start(levels: Option<LevelSender>) -> Result<Self, CaptureError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(CaptureError::NoInputDevice)?;
        let config = device
            .default_input_config()
            .map_err(|e| CaptureError::Device(e.to_string()))?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = samples.clone();
        let on_error = |e: cpal::StreamError| {
            // A dying stream just stops accumulating; stop() returns what
            // was captured so far — better a short transcript than a panic
            // on the audio thread.
            eprintln!("keepdeck-voice capture stream error: {e}");
        };

        let stream = match config.sample_format() {
            SampleFormat::F32 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        push_chunk(&sink, data, channels, levels.as_ref());
                    },
                    on_error,
                    None,
                )
                .map_err(|e| CaptureError::Device(e.to_string()))?,
            SampleFormat::I16 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[i16], _| {
                        let floats: Vec<f32> =
                            data.iter().map(|s| f32::from(*s) / 32_768.0).collect();
                        push_chunk(&sink, &floats, channels, levels.as_ref());
                    },
                    on_error,
                    None,
                )
                .map_err(|e| CaptureError::Device(e.to_string()))?,
            other => return Err(CaptureError::UnsupportedFormat(format!("{other:?}"))),
        };

        stream
            .play()
            .map_err(|e| CaptureError::Device(e.to_string()))?;

        Ok(Recorder {
            stream,
            samples,
            sample_rate,
        })
    }

    /// Stop capturing and return the whole utterance (mono, native rate).
    pub fn stop(self) -> (Vec<f32>, u32) {
        drop(self.stream);
        let samples = std::mem::take(&mut *self.samples.lock().expect("poisoned"));
        (samples, self.sample_rate)
    }
}

fn push_chunk(
    sink: &Arc<Mutex<Vec<f32>>>,
    interleaved: &[f32],
    channels: usize,
    levels: Option<&LevelSender>,
) {
    let mono = mixdown(interleaved, channels);
    if let Some(tx) = levels {
        let _ = tx.send(crate::audio::rms(&mono));
    }
    if let Ok(mut buf) = sink.lock() {
        buf.extend_from_slice(&mono);
    }
}

/// A paired level channel for callers that want the meter.
pub fn level_channel() -> (LevelSender, Receiver<f32>) {
    channel()
}
