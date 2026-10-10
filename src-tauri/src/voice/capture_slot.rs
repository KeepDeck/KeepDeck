//! The single capture slot: which push-to-talk capture currently owns the
//! microphone, and the rules for claiming and releasing it.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;

use super::error::{VoiceError, VoiceErrorKind};

pub(super) enum CaptureCmd {
    Stop,
    Cancel,
}

pub(super) struct ActiveCapture {
    pub(super) id: String,
    pub(super) plugin_id: String,
    pub(super) cmd_tx: Sender<CaptureCmd>,
    pub(super) out_rx: Receiver<Option<(Vec<f32>, u32)>>,
}

#[derive(Default)]
pub(super) struct CaptureSlot(Mutex<Option<ActiveCapture>>);

impl CaptureSlot {
    /// Whether a capture holds the slot right now.
    pub(super) fn is_busy(&self) -> bool {
        self.0.lock().expect("poisoned").is_some()
    }

    /// Claim the slot. A taken slot hands the capture BACK instead of
    /// dropping it: it owns a live recorder holding the microphone, and the
    /// caller that built it is the only one that can still tear it down.
    pub(super) fn claim(&self, capture: ActiveCapture) -> Result<(), ActiveCapture> {
        let mut slot = self.0.lock().expect("poisoned");
        if slot.is_some() {
            return Err(capture);
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
        let (cmd_tx, cmd_rx) = channel();
        let (_out_tx, out_rx) = channel();
        (
            ActiveCapture {
                id: id.into(),
                plugin_id: "plugin-a".into(),
                cmd_tx,
                out_rx,
            },
            cmd_rx,
        )
    }

    #[test]
    fn a_losing_claim_hands_its_capture_back_so_the_device_can_be_released() {
        let slot = CaptureSlot::default();
        let (first, _first_cmds) = capture("capture-a");
        let (second, second_cmds) = capture("capture-b");

        assert!(!slot.is_busy());
        assert!(slot.claim(first).is_ok(), "the slot was free");
        assert!(slot.is_busy());

        // The slot was taken while this capture's device was opening. It must
        // come back to its builder — dropping it here would strand a live
        // recorder on the microphone with nothing left to cancel it.
        let orphan = match slot.claim(second) {
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
        let (cmd_tx, _cmd_rx) = channel();
        let (_out_tx, out_rx) = channel();
        *slot.0.lock().unwrap() = Some(ActiveCapture {
            id: "capture-a".into(),
            plugin_id: "plugin-a".into(),
            cmd_tx,
            out_rx,
        });

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
