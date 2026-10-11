//! The macOS microphone permission: checked before a capture opens a device,
//! and requested when it is missing.
//!
//! The permission is checked EXPLICITLY first: starting a CoreAudio stream
//! without it does not reliably fire the TCC prompt (dev builds in
//! particular) — the OS just delivers zeros. The AVCaptureDevice request is
//! what makes the prompt appear and the Settings entry exist. The press that
//! finds it missing fires the prompt and fails with `permission`; the user
//! answers it and presses again (decision: no waiting on a human).
//!
//! A "not granted" status is not taken at its word. It is answered from a
//! cache inside this process, without asking tccd — and WebKit fills that
//! cache at launch. After an update (ad-hoc signed: a new code hash) the
//! launch-time answer is "not determined"; a grant made later through a
//! prompt that another process raised never reaches the cache, so the
//! status keeps saying no. The request DOES ask tccd: with the grant in
//! place it answers yes within milliseconds and no prompt. So a "not
//! granted" press asks and waits `ANSWER_WAIT` — a standing grant answers
//! in time, a real prompt does not.

use super::error::VoiceError;
#[cfg(target_os = "macos")]
use super::error::VoiceErrorKind;
use std::future::Future;
use std::time::Duration;
use tokio::sync::oneshot;

/// How long a press that read "not granted" waits for tccd's answer. A
/// standing grant answers in milliseconds; a human at a prompt takes longer.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ANSWER_WAIT: Duration = Duration::from_secs(1);

/// `Ok` when the app may record; otherwise fires the OS prompt and fails
/// with a `permission` error that names the fix.
pub(super) async fn ensure_microphone() -> Result<(), VoiceError> {
    #[cfg(target_os = "macos")]
    if !tauri_plugin_macos_permissions::check_microphone_permission().await {
        if granted_in_time(request_microphone_access(), ANSWER_WAIT).await {
            log::info!("voice: the cached microphone status was stale; tccd granted it");
            return Ok(());
        }
        return Err(VoiceError::new(
            VoiceErrorKind::Permission,
            "microphone permission is not granted. macOS attributes the request \
             to the app that LAUNCHED this process — if you started dev from \
             inside another app (including KeepDeck itself), that app must carry \
             NSMicrophoneUsageDescription or macOS denies silently. Launch dev \
             from a terminal once (the prompt will name the terminal), or allow \
             it in System Settings → Privacy & Security → Microphone, then hold \
             the key again",
        ));
    }
    Ok(())
}

/// `true` only when the request's answer is a grant that arrives within
/// `wait`; a refusal, a dropped request or a prompt still open is `false`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn granted_in_time(
    answer: impl Future<Output = Result<bool, oneshot::error::RecvError>>,
    wait: Duration,
) -> bool {
    matches!(tokio::time::timeout(wait, answer).await, Ok(Ok(true)))
}

/// Fire the AVCaptureDevice access request with a REAL completion block —
/// a nil completion handler (what the permissions plugin passes) fails to
/// raise the TCC dialog at least under a dev launch. The answer comes back
/// on the returned channel, and lands in the log either way so a
/// granted/denied decision is visible without the Settings app.
#[cfg(target_os = "macos")]
fn request_microphone_access() -> oneshot::Receiver<bool> {
    use block2::StackBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use std::sync::{Arc, Mutex};

    let (tx, rx) = oneshot::channel();
    // The block may be copied and is `Fn`; the sender is spent once.
    let tx = Arc::new(Mutex::new(Some(tx)));
    let media_type = NSString::from_str("soun");
    let handler = StackBlock::new(move |granted: Bool| {
        let granted = granted.as_bool();
        log::info!("voice: microphone access request completed, granted={granted}");
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(granted);
        }
    })
    .copy();
    unsafe {
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: &*media_type,
            completionHandler: &*handler
        ];
    }
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    const WAIT: Duration = Duration::from_millis(50);

    fn decide(answer: Option<bool>) -> bool {
        tauri::async_runtime::block_on(async move {
            let (tx, rx) = oneshot::channel();
            // Kept alive past the wait when there is no answer: a prompt
            // still open, not a dropped request.
            let _pending = match answer {
                Some(granted) => {
                    tx.send(granted).unwrap();
                    None
                }
                None => Some(tx),
            };
            granted_in_time(rx, WAIT).await
        })
    }

    #[test]
    fn a_standing_grant_answered_in_time_lets_the_press_record() {
        // The stale-cache case: the status said no, tccd says yes at once.
        assert!(decide(Some(true)));
    }

    #[test]
    fn a_refusal_fails_the_press() {
        assert!(!decide(Some(false)));
    }

    #[test]
    fn a_prompt_still_open_fails_the_press_instead_of_holding_it() {
        assert!(!decide(None));
    }

    #[test]
    fn a_request_that_never_answers_fails_the_press() {
        let granted = tauri::async_runtime::block_on(async {
            let (tx, rx) = oneshot::channel::<bool>();
            drop(tx);
            granted_in_time(rx, WAIT).await
        });
        assert!(!granted);
    }
}
