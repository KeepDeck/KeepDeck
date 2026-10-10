//! The single capture slot: which push-to-talk capture currently owns the
//! microphone, and the rules for claiming and releasing it.
//!
//! A capture whose owner can no longer reach it must not hold the slot
//! forever. Two ways that happens, both judged here: the webview that started
//! it reloaded (its handle died with the page — a different `session` now
//! asks), or it outlived `MAX_CAPTURE` (its recorder thread already let the
//! microphone go). Either is evicted by the next claim instead of answering
//! "busy" for the rest of the app's life.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use keepdeck_voice::Utterance;

use super::error::{VoiceError, VoiceErrorKind};

pub(super) enum CaptureCmd {
    Stop,
    Cancel,
}

/// The longest one push-to-talk capture may run. Past it the recorder thread
/// releases the microphone on its own; a real hold never gets near it.
pub(super) const MAX_CAPTURE: Duration = Duration::from_secs(300);

pub(super) struct ActiveCapture {
    pub(super) id: String,
    pub(super) plugin_id: String,
    /// The webview load that started it — one per page load, so a reload is
    /// a new session and the old one's captures are unreachable.
    pub(super) session: String,
    pub(super) started: Instant,
    pub(super) cmd_tx: Sender<CaptureCmd>,
    pub(super) out_rx: Receiver<Option<Utterance>>,
}

#[derive(Default)]
pub(super) struct CaptureSlot(Mutex<Option<ActiveCapture>>);

impl ActiveCapture {
    /// Whether nobody can stop this capture any more, as seen by a start from
    /// `session` at `now`.
    fn is_abandoned(&self, session: &str, now: Instant) -> bool {
        self.session != session || now.duration_since(self.started) >= MAX_CAPTURE
    }
}

impl CaptureSlot {
    /// Whether a live capture — one a start from `session` must wait for —
    /// holds the slot at `now`. An abandoned one does not count.
    pub(super) fn is_busy(&self, session: &str, now: Instant) -> bool {
        self.0
            .lock()
            .expect("poisoned")
            .as_ref()
            .is_some_and(|held| !held.is_abandoned(session, now))
    }

    /// Claim the slot at `now`, evicting an abandoned holder (its recorder is
    /// told to cancel, releasing the microphone). A live holder hands the
    /// capture BACK instead of dropping it: it owns a live recorder holding
    /// the microphone, and the caller that built it is the only one that can
    /// still tear it down.
    pub(super) fn claim(&self, capture: ActiveCapture, now: Instant) -> Result<(), ActiveCapture> {
        let mut slot = self.0.lock().expect("poisoned");
        if let Some(held) = slot.as_ref() {
            if !held.is_abandoned(&capture.session, now) {
                return Err(capture);
            }
            let _ = held.cmd_tx.send(CaptureCmd::Cancel);
        }
        *slot = Some(capture);
        Ok(())
    }

    /// Take the capture `capture_id` names out of the slot — only its own
    /// handle may stop or cancel it.
    pub(super) fn take(&self, capture_id: &str) -> Result<ActiveCapture, VoiceError> {
        let mut slot = self.0.lock().expect("poisoned");
        match slot.as_ref() {
            Some(capture) if capture.id == capture_id => {
                Ok(slot.take().expect("capture checked above"))
            }
            Some(_) => Err(VoiceError::new(
                VoiceErrorKind::NoCapture,
                "speech capture does not belong to this handle",
            )),
            None => Err(VoiceError::new(
                VoiceErrorKind::NoCapture,
                "no capture is running",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::channel;

    use super::*;

    /// A capture plus the command receiver its recorder thread would hold, so
    /// a send on the capture proves the recorder is still reachable.
    fn capture(id: &str) -> (ActiveCapture, Receiver<CaptureCmd>) {
        capture_in(id, "page-1", Instant::now())
    }

    fn capture_in(
        id: &str,
        session: &str,
        started: Instant,
    ) -> (ActiveCapture, Receiver<CaptureCmd>) {
        let (cmd_tx, cmd_rx) = channel();
        let (_out_tx, out_rx) = channel();
        (
            ActiveCapture {
                id: id.into(),
                plugin_id: "plugin-a".into(),
                session: session.into(),
                started,
                cmd_tx,
                out_rx,
            },
            cmd_rx,
        )
    }

    #[test]
    fn a_capture_left_by_a_reloaded_page_is_evicted_and_its_mic_released() {
        let slot = CaptureSlot::default();
        let now = Instant::now();
        let (stale, stale_cmds) = capture_in("old", "page-1", now);
        assert!(slot.claim(stale, now).is_ok());

        // The page reloaded: a new session asks, a moment later.
        assert!(!slot.is_busy("page-2", now));
        let (fresh, _fresh_cmds) = capture_in("new", "page-2", now);
        assert!(
            slot.claim(fresh, now).is_ok(),
            "the abandoned holder is evicted"
        );

        assert!(matches!(stale_cmds.try_recv(), Ok(CaptureCmd::Cancel)));
        assert_eq!(slot.0.lock().unwrap().as_ref().unwrap().id, "new");
    }

    #[test]
    fn a_capture_past_the_maximum_length_is_evicted() {
        let slot = CaptureSlot::default();
        let started = Instant::now();
        let (stale, stale_cmds) = capture_in("old", "page-1", started);
        assert!(slot.claim(stale, started).is_ok());

        let later = started + MAX_CAPTURE;
        assert!(!slot.is_busy("page-1", later));
        let (fresh, _) = capture_in("new", "page-1", later);
        assert!(slot.claim(fresh, later).is_ok());
        assert!(matches!(stale_cmds.try_recv(), Ok(CaptureCmd::Cancel)));
    }

    #[test]
    fn a_young_capture_of_the_same_page_is_never_evicted() {
        let slot = CaptureSlot::default();
        let started = Instant::now();
        let (held, held_cmds) = capture_in("held", "page-1", started);
        assert!(slot.claim(held, started).is_ok());

        // Just under the maximum, from the same page: still somebody's hold.
        let later = started + MAX_CAPTURE - Duration::from_secs(1);
        assert!(slot.is_busy("page-1", later));
        let (second, _) = capture_in("second", "page-1", later);
        assert!(slot.claim(second, later).is_err());
        assert!(
            held_cmds.try_recv().is_err(),
            "the live holder was not told to cancel"
        );
        assert_eq!(slot.0.lock().unwrap().as_ref().unwrap().id, "held");
    }

    #[test]
    fn a_losing_claim_hands_its_capture_back_so_the_device_can_be_released() {
        let slot = CaptureSlot::default();
        let (first, _first_cmds) = capture("capture-a");
        let (second, second_cmds) = capture("capture-b");

        let now = Instant::now();
        assert!(!slot.is_busy("page-1", now));
        assert!(slot.claim(first, now).is_ok(), "the slot was free");
        assert!(slot.is_busy("page-1", now));

        // The slot was taken while this capture's device was opening. It must
        // come back to its builder — dropping it here would strand a live
        // recorder on the microphone with nothing left to cancel it.
        let orphan = match slot.claim(second, now) {
            Ok(()) => panic!("the slot was already taken"),
            Err(orphan) => orphan,
        };
        assert_eq!(orphan.id, "capture-b");
        orphan
            .cmd_tx
            .send(CaptureCmd::Cancel)
            .expect("the returned capture can still be torn down");
        assert!(matches!(second_cmds.recv(), Ok(CaptureCmd::Cancel)));

        // The winner keeps the slot.
        assert_eq!(slot.0.lock().unwrap().as_ref().unwrap().id, "capture-a");
    }

    #[test]
    fn capture_handle_cannot_take_another_capture() {
        let slot = CaptureSlot::default();
        let (held, _held_cmds) = capture("capture-a");
        *slot.0.lock().unwrap() = Some(held);

        assert!(matches!(
            slot.take("capture-b"),
            Err(VoiceError {
                kind: VoiceErrorKind::NoCapture,
                ..
            })
        ));
        assert!(slot.0.lock().unwrap().is_some());
        assert_eq!(slot.take("capture-a").unwrap().plugin_id, "plugin-a");
        assert!(slot.0.lock().unwrap().is_none());
    }
}
