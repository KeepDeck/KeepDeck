//! Microphone capture. One `Recorder` owns one cpal input stream on the
//! default device; every callback goes through the `signal::Conditioner`
//! (offset removed, loudest channel kept, facts measured) and accumulates
//! until `stop()`, which hands back the whole utterance — push-to-talk bounds
//! the recording, so batch-on-release needs no ring buffer or VAD chunking.

use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, SampleFormat, SizedSample, Stream, StreamConfig};

use crate::signal::{Conditioner, LevelReading, Utterance};

/// What each callback measured, for a live indicator. Bounded and sent
/// best-effort — a full channel drops the newest reading rather than blocking
/// the REALTIME audio thread or growing without limit when nobody drains it.
pub type LevelSender = SyncSender<LevelReading>;

/// Readings the channel holds before it drops new ones — about half a second
/// of callbacks; the meter is drained ~30 times a second.
const LEVEL_BUFFER: usize = 64;

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

        let format = config.sample_format();
        let config: StreamConfig = config.into();
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, &config, sink, levels),
            SampleFormat::F64 => build::<f64>(&device, &config, sink, levels),
            SampleFormat::I8 => build::<i8>(&device, &config, sink, levels),
            SampleFormat::I16 => build::<i16>(&device, &config, sink, levels),
            SampleFormat::I32 => build::<i32>(&device, &config, sink, levels),
            SampleFormat::I64 => build::<i64>(&device, &config, sink, levels),
            SampleFormat::U8 => build::<u8>(&device, &config, sink, levels),
            SampleFormat::U16 => build::<u16>(&device, &config, sink, levels),
            SampleFormat::U32 => build::<u32>(&device, &config, sink, levels),
            SampleFormat::U64 => build::<u64>(&device, &config, sink, levels),
            other => return Err(CaptureError::UnsupportedFormat(format!("{other:?}"))),
        }?;

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

/// Open the input stream for one sample type: every format is converted to
/// f32 in -1..1 the same way (cpal's own sample conversion), so no format is
/// refused for being other than f32/i16.
fn build<T>(
    device: &Device,
    config: &StreamConfig,
    sink: Arc<Mutex<Option<Conditioner>>>,
    levels: Option<LevelSender>,
) -> Result<Stream, CaptureError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                push_chunk(&sink, &unit_floats(data), levels.as_ref());
            },
            // A dying stream just stops delivering; stop() returns what was
            // captured so far and the hold is judged cut short — better a
            // short transcript than a panic on the audio thread.
            |e: cpal::StreamError| eprintln!("keepdeck-voice capture stream error: {e}"),
            None,
        )
        .map_err(|e| CaptureError::Device(e.to_string()))
}

/// Any sample type as f32 in -1..1, silence at 0 (unsigned formats are
/// centred) — cpal's own conversion, so every format means the same level.
fn unit_floats<T>(data: &[T]) -> Vec<f32>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    data.iter().map(|&s| s.to_sample::<f32>()).collect()
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
        // Never block the realtime thread: a full channel drops this reading.
        let _ = tx.try_send(reading);
    }
}

/// A paired level channel for callers that want the meter.
pub fn level_channel() -> (LevelSender, Receiver<LevelReading>) {
    sync_channel(LEVEL_BUFFER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_format_maps_to_the_same_unit_range() {
        assert_eq!(unit_floats(&[0i16, i16::MIN]), vec![0.0, -1.0]);
        assert_eq!(unit_floats(&[0i32, i32::MIN]), vec![0.0, -1.0]);
        // Unsigned formats are centred: their midpoint is silence.
        assert_eq!(unit_floats(&[128u8, 0u8]), vec![0.0, -1.0]);
        assert_eq!(unit_floats(&[32_768u16]), vec![0.0]);
        assert_eq!(unit_floats(&[0.5f64]), vec![0.5]);
    }

    #[test]
    fn a_full_level_channel_drops_readings_instead_of_blocking() {
        let (tx, rx) = level_channel();
        for _ in 0..LEVEL_BUFFER + 10 {
            // try_send never blocks; past the bound it reports Full.
            let _ = tx.try_send(LevelReading::default());
        }
        assert_eq!(rx.try_iter().count(), LEVEL_BUFFER);
    }
}
