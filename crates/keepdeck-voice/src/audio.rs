//! Pure sample math: mono mixdown, resampling, and the silence gate. Kept
//! free of cpal/whisper so every step of the pipeline between the microphone
//! callback and inference is unit-testable.

/// Whisper consumes 16 kHz mono f32.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// Average interleaved channels down to mono.
pub fn mixdown(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Linear-interpolation resampler. Speech-to-text is tolerant of the mild
/// aliasing a linear kernel leaves behind; a windowed-sinc resampler can
/// replace this behind the same signature if quality ever demands it.
pub fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((samples.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let base = pos.floor() as usize;
        let frac = (pos - base as f64) as f32;
        let a = samples[base];
        let b = samples.get(base + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Root-mean-square level of a chunk — the live level meter and the gate
/// below share this.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// Whisper pads short input to 30 s and HALLUCINATES on silence ("Thank you
/// for watching!") — a push-to-talk tap with no speech must be dropped before
/// inference, not transcribed. The threshold is deliberately low: it only has
/// to separate "nothing said" from speech, not judge loudness.
pub const SILENCE_RMS: f32 = 0.0025;

pub fn is_silence(samples: &[f32]) -> bool {
    rms(samples) < SILENCE_RMS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixdown_averages_channels() {
        assert_eq!(mixdown(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        // Mono passes through untouched.
        assert_eq!(mixdown(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn resample_halves_a_double_rate_signal() {
        let input: Vec<f32> = (0..8).map(|i| i as f32).collect();
        let out = resample(&input, 32_000, 16_000);
        assert_eq!(out, vec![0.0, 2.0, 4.0, 6.0]);
    }

    #[test]
    fn resample_interpolates_between_neighbours() {
        // 3:2 downrate lands between input samples; linear interpolation
        // must produce the in-between values, not nearest-neighbour steps.
        let out = resample(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0], 24_000, 16_000);
        assert_eq!(out, vec![0.0, 1.5, 3.0, 4.5]);
    }

    #[test]
    fn resample_same_rate_is_identity() {
        let input = vec![0.25, -0.5];
        assert_eq!(resample(&input, 16_000, 16_000), input);
    }

    #[test]
    fn silence_gate_separates_quiet_from_speechlike() {
        let quiet = vec![0.0005_f32; 16_000];
        let speechlike: Vec<f32> =
            (0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.2).collect();
        assert!(is_silence(&quiet));
        assert!(!is_silence(&speechlike));
        assert!(is_silence(&[]));
    }
}
