//! Signal conditioning between the device callback and everything that reads
//! the audio: the level meter, the silence judgment and the model.
//!
//! Some microphones deliver a constant offset on top of the sound (a
//! BY-PM700 was measured drifting from 0 to +0.30 over hours). Left in, it
//! pins the meter, defeats the silence gate and shifts what the model hears.
//! So every channel goes through a DC blocker FIRST, and every measurement is
//! taken on the clean signal — except clipping, which is a fact about the raw
//! samples the converter produced.
//!
//! Channels are not averaged: a device that presents a mono capsule as stereo
//! with one dead (or phase-inverted) channel would halve (or cancel) the
//! voice. The utterance is the LOUDEST channel.

use crate::audio::rms;

/// The DC blocker's corner frequency. Speech carries nothing below ~80 Hz;
/// 20 Hz removes the offset (and its slow drift) without touching it.
const DC_CORNER_HZ: f32 = 20.0;

/// How fast the reported offset follows the raw signal — a display figure,
/// not part of the filtering.
const DC_ESTIMATE_SECONDS: f32 = 0.5;

/// A raw sample at or past this magnitude hit the converter's ceiling.
pub const CLIP_LEVEL: f32 = 0.999;

/// One-pole DC blocker: `y[n] = x[n] − x[n−1] + R·y[n−1]`.
#[derive(Clone, Debug)]
struct DcBlocker {
    r: f32,
    prev_in: Option<f32>,
    prev_out: f32,
}

impl DcBlocker {
    fn new(sample_rate: u32) -> Self {
        let r = 1.0 - 2.0 * std::f32::consts::PI * DC_CORNER_HZ / sample_rate.max(1) as f32;
        DcBlocker {
            r: r.clamp(0.0, 1.0),
            prev_in: None,
            prev_out: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        // Seeded with the first sample, so an offset present from the first
        // callback produces no step (and no click) at the start.
        let prev_in = self.prev_in.unwrap_or(x);
        let y = x - prev_in + self.r * self.prev_out;
        self.prev_in = Some(x);
        self.prev_out = y;
        y
    }
}

/// What one device callback measured.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LevelReading {
    /// RMS of the loudest channel after the offset is removed.
    pub rms: f32,
    /// Largest raw magnitude in the chunk, 0..=1.
    pub peak: f32,
    /// Whether any raw sample hit the ceiling.
    pub clipped: bool,
    /// The constant offset the device is adding right now (signed, largest
    /// across channels).
    pub dc_offset: f32,
}

/// A finished recording: the clean loudest channel plus what was measured
/// over the whole of it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Utterance {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub peak: f32,
    /// Share of raw samples that hit the ceiling, 0..=1.
    pub clipped_ratio: f32,
    pub dc_offset: f32,
}

/// Conditions one capture's interleaved samples as they arrive.
pub struct Conditioner {
    sample_rate: u32,
    blockers: Vec<DcBlocker>,
    dc_alpha: f32,
    dc: Vec<f32>,
    channels: Vec<Vec<f32>>,
    energy: Vec<f64>,
    peak: f32,
    clipped: u64,
    total: u64,
}

impl Conditioner {
    pub fn new(sample_rate: u32, channels: usize) -> Self {
        let channels = channels.max(1);
        let tau = DC_ESTIMATE_SECONDS * sample_rate.max(1) as f32;
        Conditioner {
            sample_rate,
            blockers: vec![DcBlocker::new(sample_rate); channels],
            dc_alpha: 1.0 - (-1.0 / tau).exp(),
            dc: vec![0.0; channels],
            channels: vec![Vec::new(); channels],
            energy: vec![0.0; channels],
            peak: 0.0,
            clipped: 0,
            total: 0,
        }
    }

    /// Condition one interleaved chunk and say what it measured.
    pub fn push(&mut self, interleaved: &[f32]) -> LevelReading {
        let n = self.channels.len();
        let mut chunk: Vec<Vec<f32>> = vec![Vec::with_capacity(interleaved.len() / n); n];
        let mut peak = 0.0_f32;
        let mut clipped = false;
        for frame in interleaved.chunks_exact(n) {
            for (c, &x) in frame.iter().enumerate() {
                let magnitude = x.abs();
                peak = peak.max(magnitude);
                if magnitude >= CLIP_LEVEL {
                    clipped = true;
                    self.clipped += 1;
                }
                self.total += 1;
                // Seed the estimate with the first sample, like the blocker.
                if self.blockers[c].prev_in.is_none() {
                    self.dc[c] = x;
                }
                self.dc[c] += self.dc_alpha * (x - self.dc[c]);
                chunk[c].push(self.blockers[c].process(x));
            }
        }
        let mut loudest = 0.0_f32;
        for (c, clean) in chunk.into_iter().enumerate() {
            let level = rms(&clean);
            loudest = loudest.max(level);
            self.energy[c] += clean.iter().map(|s| f64::from(s * s)).sum::<f64>();
            self.channels[c].extend(clean);
        }
        self.peak = self.peak.max(peak);
        LevelReading {
            rms: loudest,
            peak,
            clipped,
            dc_offset: self.dc_offset(),
        }
    }

    fn dc_offset(&self) -> f32 {
        self.dc.iter().copied().fold(
            0.0_f32,
            |best, d| if d.abs() > best.abs() { d } else { best },
        )
    }

    /// The whole recording: the loudest channel, clean, with its facts.
    pub fn finish(self) -> Utterance {
        let dc_offset = self.dc_offset();
        let loudest = self
            .energy
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map_or(0, |(c, _)| c);
        Utterance {
            samples: self.channels.into_iter().nth(loudest).unwrap_or_default(),
            sample_rate: self.sample_rate,
            peak: self.peak,
            clipped_ratio: if self.total == 0 {
                0.0
            } else {
                self.clipped as f32 / self.total as f32
            },
            dc_offset,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn tone(len: usize, amplitude: f32, offset: f32) -> Vec<f32> {
        (0..len)
            .map(|i| {
                offset
                    + amplitude
                        * (i as f32 * 2.0 * std::f32::consts::PI * 300.0 / RATE as f32).sin()
            })
            .collect()
    }

    fn mono(samples: &[f32]) -> Utterance {
        let mut c = Conditioner::new(RATE, 1);
        c.push(samples);
        c.finish()
    }

    #[test]
    fn a_constant_offset_is_removed_and_reported() {
        // The measured BY-PM700 case: +0.30 offset under a quiet room.
        let mut c = Conditioner::new(RATE, 1);
        let reading = c.push(&vec![0.30; RATE as usize]);
        assert!(
            reading.rms < 0.001,
            "an offset alone is not sound: {}",
            reading.rms
        );
        assert!(
            (reading.dc_offset - 0.30).abs() < 0.01,
            "offset reported: {}",
            reading.dc_offset
        );
        let u = c.finish();
        assert!(rms(&u.samples) < 0.001);
    }

    #[test]
    fn speech_on_top_of_an_offset_keeps_its_level() {
        let clean = mono(&tone(RATE as usize, 0.1, 0.0));
        let offset = mono(&tone(RATE as usize, 0.1, 0.25));
        let (a, b) = (rms(&clean.samples), rms(&offset.samples));
        assert!(
            (a - b).abs() / a < 0.02,
            "level with offset {b} vs without {a}"
        );
        assert!(
            (a - 0.1 / 2f32.sqrt()).abs() < 0.005,
            "a 300 Hz tone passes untouched: {a}"
        );
    }

    #[test]
    fn a_drifting_offset_is_tracked_and_removed() {
        // Offset climbing 0 → 0.2 across one second, under a tone.
        let len = RATE as usize;
        let samples: Vec<f32> = tone(len, 0.05, 0.0)
            .into_iter()
            .enumerate()
            .map(|(i, s)| s + 0.2 * i as f32 / len as f32)
            .collect();
        let u = mono(&samples);
        let tail = &u.samples[len / 2..];
        assert!(
            (rms(tail) - 0.05 / 2f32.sqrt()).abs() < 0.003,
            "drift removed: {}",
            rms(tail)
        );
    }

    #[test]
    fn the_loudest_channel_is_the_utterance_not_the_average() {
        // A mono capsule presented as stereo with a dead right channel.
        let left = tone(RATE as usize, 0.2, 0.0);
        let interleaved: Vec<f32> = left.iter().flat_map(|&l| [l, 0.0]).collect();
        let mut c = Conditioner::new(RATE, 2);
        let reading = c.push(&interleaved);
        let u = c.finish();
        assert_eq!(u.samples.len(), left.len());
        assert!(
            (rms(&u.samples) - 0.2 / 2f32.sqrt()).abs() < 0.005,
            "not halved: {}",
            rms(&u.samples)
        );
        assert!((reading.rms - rms(&u.samples)).abs() < 0.005);
    }

    #[test]
    fn opposite_phase_channels_do_not_cancel() {
        let left = tone(RATE as usize, 0.2, 0.0);
        let interleaved: Vec<f32> = left.iter().flat_map(|&l| [l, -l]).collect();
        let mut c = Conditioner::new(RATE, 2);
        c.push(&interleaved);
        assert!(rms(&c.finish().samples) > 0.1);
    }

    #[test]
    fn clipping_is_counted_on_the_raw_samples() {
        let mut samples = tone(1_000, 0.5, 0.0);
        samples[10] = 1.0;
        samples[20] = -1.0;
        let mut c = Conditioner::new(RATE, 1);
        let reading = c.push(&samples);
        assert!(reading.clipped);
        assert_eq!(reading.peak, 1.0);
        let u = c.finish();
        assert!((u.clipped_ratio - 2.0 / 1_000.0).abs() < 1e-6);
        assert_eq!(u.peak, 1.0);
    }

    #[test]
    fn nothing_recorded_is_an_empty_quiet_utterance() {
        let u = Conditioner::new(RATE, 2).finish();
        assert!(u.samples.is_empty());
        assert_eq!(u.clipped_ratio, 0.0);
        assert_eq!(u.peak, 0.0);
    }
}
