//! What a finished push-to-talk hold amounts to, judged once, natively —
//! so no caller re-derives it from thresholds of its own.

/// Below this captured length a hold delivered no audio at all.
const NO_AUDIO_SECONDS: f32 = 0.05;
/// A hold this short is a tap: too short to judge a stall or a dead signal.
const MIN_JUDGED_HOLD_SECONDS: f32 = 0.3;
/// Raw peak below this is digital zero — no microphone produces it; macOS
/// does when it withholds the microphone without saying so.
const DEAD_SIGNAL_PEAK: f32 = 1e-4;
/// Captured audio covering less than this share of the hold means the
/// device stopped delivering partway (unplugged, or the stream died).
const CUT_SHORT_SHARE: f32 = 0.8;

/// Why a hold produced no speech.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SilenceReason {
    /// The device delivered no audio at all.
    NoAudio,
    /// Audio arrived but it is digital zero — the OS withholds the mic.
    DeadSignal,
    /// Real audio, nobody spoke (or too briefly to count).
    NoSpeech,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HoldJudgment {
    /// `None` when the hold has speech.
    pub silence: Option<SilenceReason>,
    /// The audio stopped arriving before the key was released.
    pub cut_short: bool,
}

/// Judge one hold: how long the key was held, how much audio arrived, the
/// raw peak, and whether the speech check found speech.
pub fn judge_hold(
    held_seconds: f32,
    captured_seconds: f32,
    peak: f32,
    speech: bool,
) -> HoldJudgment {
    let judged = held_seconds >= MIN_JUDGED_HOLD_SECONDS;
    let no_audio = captured_seconds < NO_AUDIO_SECONDS;
    let silence = if speech {
        None
    } else if no_audio {
        Some(SilenceReason::NoAudio)
    } else if judged && peak < DEAD_SIGNAL_PEAK {
        Some(SilenceReason::DeadSignal)
    } else {
        Some(SilenceReason::NoSpeech)
    };
    HoldJudgment {
        silence,
        cut_short: judged && !no_audio && captured_seconds < CUT_SHORT_SHARE * held_seconds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hold_with_speech_has_no_silence_reason() {
        let j = judge_hold(2.0, 1.98, 0.4, true);
        assert_eq!(
            j,
            HoldJudgment {
                silence: None,
                cut_short: false
            }
        );
    }

    #[test]
    fn a_hold_that_delivered_nothing_is_no_audio() {
        assert_eq!(
            judge_hold(2.0, 0.0, 0.0, false).silence,
            Some(SilenceReason::NoAudio)
        );
    }

    #[test]
    fn digital_zero_over_a_real_hold_is_a_dead_signal() {
        assert_eq!(
            judge_hold(1.5, 1.5, 0.0, false).silence,
            Some(SilenceReason::DeadSignal)
        );
        // A quiet room is never digital zero.
        assert_eq!(
            judge_hold(1.5, 1.5, 0.002, false).silence,
            Some(SilenceReason::NoSpeech)
        );
    }

    #[test]
    fn a_tap_is_never_judged_dead_or_cut_short() {
        let j = judge_hold(0.1, 0.06, 0.0, false);
        assert_eq!(j.silence, Some(SilenceReason::NoSpeech));
        assert!(!j.cut_short);
    }

    #[test]
    fn audio_that_stopped_partway_is_cut_short_even_with_speech() {
        // Held 5 s, the device delivered 2 s, then went quiet (unplugged).
        let j = judge_hold(5.0, 2.0, 0.5, true);
        assert_eq!(j.silence, None);
        assert!(j.cut_short);
        // A normal hold loses only the device-open moment.
        assert!(!judge_hold(5.0, 4.9, 0.5, true).cut_short);
    }
}
