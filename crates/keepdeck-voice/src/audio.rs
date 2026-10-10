//! Pure sample math: resampling, levels, and the speech check. Kept free of
//! cpal/whisper so every step of the pipeline between the microphone callback
//! and inference is unit-testable.

/// Whisper consumes 16 kHz mono f32.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

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
/// inference, not transcribed.
///
/// The judgment is per short frame, not one RMS over the whole hold: a quiet
/// phrase inside a long hold has a whole-utterance RMS at the room's level
/// (measured: ambient 0.0003 median, 0.0025 at p90 in a street-noisy room;
/// quiet speech 0.002–0.003 overall), yet its voiced frames stand well above
/// the room. A frame is voiced when it is louder than both an absolute floor
/// and a multiple of the hold's own noise floor (its quiet 20th percentile);
/// the hold has speech when voiced frames add up to a syllable or more.
/// Expects the offset already removed (see `signal`).
const FRAME_SECONDS: f32 = 0.02;
/// The quietest frame RMS that can count as voice at all.
pub const VOICED_FRAME_RMS: f32 = 0.004;
/// How far above this hold's own noise floor a voiced frame stands.
const ABOVE_FLOOR: f32 = 3.0;
/// Voiced time that makes a hold speech — about one short syllable.
const MIN_SPEECH_SECONDS: f32 = 0.12;

/// The RMS of each voiced frame — frames that stand above both the absolute
/// floor and this hold's own noise floor. The speech check and the loudness
/// normalisation read speech the same way, through this one function.
fn voiced_frames(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let frame = ((sample_rate as f32 * FRAME_SECONDS) as usize).max(1);
    let mut levels: Vec<f32> = samples.chunks(frame).map(rms).collect();
    if levels.is_empty() {
        return levels;
    }
    let mut sorted = levels.clone();
    sorted.sort_by(f32::total_cmp);
    let floor = sorted[sorted.len() / 5];
    let threshold = VOICED_FRAME_RMS.max(ABOVE_FLOOR * floor);
    levels.retain(|&level| level >= threshold);
    levels
}

pub fn has_speech(samples: &[f32], sample_rate: u32) -> bool {
    let voiced_needed = (MIN_SPEECH_SECONDS / FRAME_SECONDS).ceil() as usize;
    voiced_frames(samples, sample_rate).len() >= voiced_needed
}

/// The loudness every utterance is brought to before the model: the RMS of
/// its voiced frames at about −20 dBFS, where speech models are trained.
const TARGET_VOICED_RMS: f32 = 0.1;
/// The most a quiet utterance is raised (+20 dB): enough for a low input
/// gain, not so much that a near-silent hold becomes loud noise.
const MAX_GAIN: f32 = 10.0;
/// The most a loud utterance is lowered (−20 dB).
const MIN_GAIN: f32 = 0.1;
/// Above this magnitude the limiter starts bending peaks down.
const LIMIT_KNEE: f32 = 0.9;
/// What the limiter's curve approaches and never passes — just under full
/// scale, so even a saturated curve (f32 tanh reaches 1.0) cannot clip.
const LIMIT_CEILING: f32 = 0.98;

/// Bring one whole utterance to the model's loudness — quiet speech up, loud
/// speech down — then soft-limit what still overshoots, so the result never
/// reaches the ceiling. One gain for the whole utterance (no pumping inside
/// a phrase); measured on voiced frames only, so pauses and room noise do not
/// drag the gain up. An utterance with no voiced frame is returned as is.
pub fn normalize_loudness(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let voiced = voiced_frames(samples, sample_rate);
    if voiced.is_empty() {
        return samples.to_vec();
    }
    let mean_square = voiced.iter().map(|l| l * l).sum::<f32>() / voiced.len() as f32;
    let gain = (TARGET_VOICED_RMS / mean_square.sqrt()).clamp(MIN_GAIN, MAX_GAIN);
    samples.iter().map(|&s| soft_limit(s * gain)).collect()
}

/// Identity below the knee; above it, a tanh curve towards the ceiling —
/// peaks bend instead of clipping.
fn soft_limit(x: f32) -> f32 {
    let magnitude = x.abs();
    if magnitude <= LIMIT_KNEE {
        return x;
    }
    let room = LIMIT_CEILING - LIMIT_KNEE;
    x.signum() * (LIMIT_KNEE + room * ((magnitude - LIMIT_KNEE) / room).tanh())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    const RATE: u32 = 16_000;

    /// Deterministic noise of a given RMS (uniform ±a has RMS a/√3).
    fn noise(len: usize, level: f32, seed: u32) -> Vec<f32> {
        let mut state = seed.wrapping_mul(2_654_435_761).max(1);
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32 * 2.0 - 1.0) * level * 3f32.sqrt()
            })
            .collect()
    }

    fn with_burst(mut base: Vec<f32>, from_s: f32, seconds: f32, level: f32) -> Vec<f32> {
        let start = (from_s * RATE as f32) as usize;
        let len = (seconds * RATE as f32) as usize;
        for i in 0..len {
            base[start + i] += level * 2f32.sqrt() * (i as f32 * 0.12).sin();
        }
        base
    }

    #[test]
    fn a_quiet_room_is_not_speech() {
        assert!(!has_speech(&noise(2 * RATE as usize, 0.0003, 1), RATE));
        // The noisy end of the measured room (p90).
        assert!(!has_speech(&noise(2 * RATE as usize, 0.0025, 2), RATE));
        assert!(!has_speech(&[], RATE));
        assert!(!has_speech(&vec![0.0; RATE as usize], RATE));
    }

    #[test]
    fn a_steady_noise_louder_than_the_voice_floor_is_not_speech() {
        // A fan or street hum above the absolute floor: only its own level
        // decides, and a steady level has no voiced frames above it.
        assert!(!has_speech(&noise(2 * RATE as usize, 0.008, 6), RATE));
        // The same hum with a phrase on top is speech.
        let hold = with_burst(noise(2 * RATE as usize, 0.008, 7), 0.5, 0.5, 0.05);
        assert!(has_speech(&hold, RATE));
    }

    #[test]
    fn a_quiet_phrase_in_a_long_hold_is_speech() {
        // 3 s hold, 0.4 s of quiet voice at 0.01: the whole-hold RMS is
        // ~0.0037 — a single-RMS gate at 0.0025 barely passes it, one at the
        // room's p90 would not; the frames see it plainly.
        let hold = with_burst(noise(3 * RATE as usize, 0.0003, 3), 1.0, 0.4, 0.01);
        assert!(has_speech(&hold, RATE));
    }

    #[test]
    fn speech_over_a_noisy_room_is_speech() {
        let hold = with_burst(noise(2 * RATE as usize, 0.0025, 4), 0.5, 0.5, 0.03);
        assert!(has_speech(&hold, RATE));
    }

    fn voiced_rms(samples: &[f32]) -> f32 {
        let v = voiced_frames(samples, RATE);
        (v.iter().map(|l| l * l).sum::<f32>() / v.len() as f32).sqrt()
    }

    #[test]
    fn quiet_speech_is_raised_to_the_target() {
        // The measured low-gain case: a phrase at ~0.01 over a quiet room.
        let hold = with_burst(noise(2 * RATE as usize, 0.0003, 8), 0.5, 0.6, 0.01);
        let out = normalize_loudness(&hold, RATE);
        assert!(
            (voiced_rms(&out) - TARGET_VOICED_RMS).abs() < 0.01,
            "{}",
            voiced_rms(&out)
        );
    }

    #[test]
    fn loud_speech_is_lowered_to_the_target() {
        let hold = with_burst(noise(2 * RATE as usize, 0.0003, 9), 0.5, 0.6, 0.5);
        let out = normalize_loudness(&hold, RATE);
        assert!(
            (voiced_rms(&out) - TARGET_VOICED_RMS).abs() < 0.01,
            "{}",
            voiced_rms(&out)
        );
    }

    #[test]
    fn a_near_silent_phrase_is_raised_no_more_than_the_gain_cap() {
        let hold = with_burst(noise(2 * RATE as usize, 0.0003, 10), 0.5, 0.6, 0.005);
        let out = normalize_loudness(&hold, RATE);
        let gain = rms(&out) / rms(&hold);
        assert!(gain <= MAX_GAIN + 1e-3, "gain {gain}");
    }

    #[test]
    fn the_result_never_reaches_the_ceiling() {
        // A loud phrase with one far louder spike: the gain is set by the
        // phrase, the spike is bent under 1.0, not clipped at it.
        let mut hold = with_burst(noise(2 * RATE as usize, 0.0003, 11), 0.5, 0.6, 0.02);
        hold[RATE as usize] = 0.9;
        let out = normalize_loudness(&hold, RATE);
        assert!(out.iter().all(|s| s.abs() <= LIMIT_CEILING));
        assert!(
            out[RATE as usize] > LIMIT_KNEE,
            "the spike stays a peak, only bent"
        );
    }

    #[test]
    fn a_hold_without_speech_is_left_alone() {
        let room = noise(RATE as usize, 0.0003, 12);
        assert_eq!(normalize_loudness(&room, RATE), room);
    }

    #[test]
    fn a_click_shorter_than_a_syllable_is_not_speech() {
        let hold = with_burst(noise(2 * RATE as usize, 0.0003, 5), 0.5, 0.06, 0.2);
        assert!(!has_speech(&hold, RATE));
    }
}
