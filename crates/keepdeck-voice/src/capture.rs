//! Microphone capture. One `Recorder` owns one cpal input stream on the
//! default device; every callback goes through the `signal::Conditioner`
//! (offset removed, loudest channel kept, facts measured) and accumulates
//! until `stop()`, which hands back the whole utterance — push-to-talk bounds
//! the recording, so batch-on-release needs no ring buffer or VAD chunking.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};

use crate::signal::{Conditioner, LevelReading, Utterance};

/// What each callback measured, for a live indicator. Sent best-effort —
/// a full channel drops the newest reading rather than blocking the
/// REALTIME audio thread.
pub type LevelSender = Sender<LevelReading>;

/// A finished capture: the conditioned utterance and the device it came from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Recording {
    /// The device's name as the OS shows it ("MacBook Pro Microphone").
    pub device: String,
    pub utterance: Utterance,
}

pub struct Recorder {
    // cpal's Stream is deliberately !Send; keeping it alive keeps capture
    // running, dropping it stops the device.
    stream: Stream,
    /// Taken by `stop()`; a callback racing the teardown finds it gone.
    conditioner: Arc<Mutex<Option<Conditioner>>>,
    device: String,
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
        let device_name = device.name().unwrap_or_default();
        let config = device
            .default_input_config()
            .map_err(|e| CaptureError::Device(e.to_string()))?;
        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        let conditioner = Arc::new(Mutex::new(Some(Conditioner::new(sample_rate, channels))));
        let sink = conditioner.clone();
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
                        push_chunk(&sink, data, levels.as_ref());
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
                        push_chunk(&sink, &floats, levels.as_ref());
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
            conditioner,
            device: device_name,
        })
    }

    /// Stop capturing and return the whole utterance (clean, loudest
    /// channel, native rate) with what was measured over it.
    pub fn stop(self) -> Recording {
        drop(self.stream);
        let taken = self.conditioner.lock().expect("poisoned").take();
        Recording {
            device: self.device,
            utterance: taken.map(Conditioner::finish).unwrap_or_default(),
        }
    }
}

fn push_chunk(
    sink: &Arc<Mutex<Option<Conditioner>>>,
    interleaved: &[f32],
    levels: Option<&LevelSender>,
) {
    let reading = match sink.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(conditioner) => conditioner.push(interleaved),
            None => return,
        },
        Err(_) => return,
    };
    if let Some(tx) = levels {
        let _ = tx.send(reading);
    }
}

/// A paired level channel for callers that want the meter.
pub fn level_channel() -> (LevelSender, Receiver<LevelReading>) {
    channel()
}
