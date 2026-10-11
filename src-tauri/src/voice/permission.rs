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

use super::error::{VoiceError, VoiceErrorKind};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

/// How long a press that read "not granted" waits for tccd's answer.
///
/// A latency budget, not a guarantee: no answer time is documented. A
/// standing grant has answered in ~2 ms (tccd's own log), so a second is
/// generous; a tccd slower than that fails the press with `permission` and
/// the next press, the cache refreshed by then, records. The other edge is
/// harmless — a human who allows the prompt within the second records at
/// once, as they asked to.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const ANSWER_WAIT: Duration = Duration::from_secs(1);

/// `Ok` when the app may record; otherwise fires the OS prompt and fails
/// with a `permission` error that names the fix.
pub(super) async fn ensure_microphone() -> Result<(), VoiceError> {
    #[cfg(target_os = "macos")]
    return ensure_with(
        tauri_plugin_macos_permissions::check_microphone_permission(),
        request_microphone_access,
        ANSWER_WAIT,
    )
    .await;
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

/// The decision, over the two platform calls: `cached` is the in-process
/// status (may be stale), `request` asks tccd and answers on a channel.
/// Only a grant that arrives within `wait` overturns a "not granted".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn ensure_with(
    cached: impl Future<Output = bool>,
    request: impl FnOnce() -> oneshot::Receiver<bool>,
    wait: Duration,
) -> Result<(), VoiceError> {
    if cached.await {
        return Ok(());
    }
    if matches!(tokio::time::timeout(wait, request()).await, Ok(Ok(true))) {
        log::info!("voice: the cached microphone status was stale; tccd granted it");
        return Ok(());
    }
    Err(VoiceError::new(
        VoiceErrorKind::Permission,
        "microphone permission is not granted. macOS attributes the request \
         to the app that LAUNCHED this process — if you started dev from \
         inside another app (including KeepDeck itself), that app must carry \
         NSMicrophoneUsageDescription or macOS denies silently. Launch dev \
         from a terminal once (the prompt will name the terminal), or allow \
         it in System Settings → Privacy & Security → Microphone, then hold \
         the key again",
    ))
}

/// The completion side of a request: a callback that may be cloned and
/// called any number of times, from any thread, and puts the FIRST answer
/// on the receiver. Logged every time, so a granted/denied decision is
/// visible without the Settings app; an answer nobody waits for any more
/// (the wait timed out) is dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn answer_channel() -> (
    impl Fn(bool) + Clone + Send + Sync + 'static,
    oneshot::Receiver<bool>,
) {
    let (tx, rx) = oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let answer = move |granted: bool| {
        log::info!("voice: microphone access request completed, granted={granted}");
        let sender = tx.lock().ok().and_then(|mut slot| slot.take());
        if let Some(sender) = sender {
            let _ = sender.send(granted);
        }
    };
    (answer, rx)
}

/// The Objective-C completion block around `answer`, copied to the heap so
/// it outlives the call that registers it.
#[cfg(target_os = "macos")]
fn completion_block(
    answer: impl Fn(bool) + Clone + 'static,
) -> block2::RcBlock<dyn Fn(objc2::runtime::Bool)> {
    use block2::StackBlock;
    use objc2::runtime::Bool;

    StackBlock::new(move |granted: Bool| answer(granted.as_bool())).copy()
}

/// Fire the AVCaptureDevice access request with a REAL completion block —
/// a nil completion handler (what the permissions plugin passes) fails to
/// raise the TCC dialog at least under a dev launch. The answer comes back
/// on the returned channel.
#[cfg(target_os = "macos")]
fn request_microphone_access() -> oneshot::Receiver<bool> {
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let (answer, rx) = answer_channel();
    let handler = completion_block(answer);
    let media_type = NSString::from_str("soun");
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
    use std::sync::atomic::{AtomicBool, Ordering};

    const WAIT: Duration = Duration::from_millis(100);

    fn run<T>(f: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    /// A request that answers `answer` after `delay` (None: never answers,
    /// the sender kept alive — a prompt still open).
    fn answering(answer: Option<bool>, delay: Duration) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            match answer {
                Some(granted) => {
                    let _ = tx.send(granted);
                }
                None => {
                    tokio::time::sleep(WAIT * 10).await;
                    drop(tx);
                }
            }
        });
        rx
    }

    fn is_permission(result: Result<(), VoiceError>) -> bool {
        matches!(result, Err(e) if e.kind == VoiceErrorKind::Permission)
    }

    #[test]
    fn a_granted_status_records_without_asking() {
        let asked = AtomicBool::new(false);
        let result = run(ensure_with(
            async { true },
            || {
                asked.store(true, Ordering::SeqCst);
                answering(Some(false), Duration::ZERO)
            },
            WAIT,
        ));
        assert!(result.is_ok());
        assert!(!asked.load(Ordering::SeqCst));
    }

    #[test]
    fn a_stale_status_is_overturned_by_tccd_s_grant() {
        // The bug: the cache said no, tccd says yes at once.
        let result = run(ensure_with(
            async { false },
            || answering(Some(true), Duration::ZERO),
            WAIT,
        ));
        assert!(result.is_ok());
    }

    #[test]
    fn a_grant_that_arrives_before_the_deadline_records() {
        let result = run(ensure_with(
            async { false },
            || answering(Some(true), WAIT / 4),
            WAIT,
        ));
        assert!(result.is_ok());
    }

    #[test]
    fn a_refusal_fails_with_permission() {
        let result = run(ensure_with(
            async { false },
            || answering(Some(false), Duration::ZERO),
            WAIT,
        ));
        assert!(is_permission(result));
    }

    #[test]
    fn a_prompt_still_open_fails_instead_of_holding_the_press() {
        let result = run(ensure_with(
            async { false },
            || answering(None, Duration::ZERO),
            WAIT,
        ));
        assert!(is_permission(result));
    }

    #[test]
    fn a_grant_after_the_deadline_is_too_late() {
        let result = run(ensure_with(
            async { false },
            || answering(Some(true), WAIT * 3),
            WAIT,
        ));
        assert!(is_permission(result));
    }

    #[test]
    fn a_request_dropped_unanswered_fails_with_permission() {
        let result = run(ensure_with(
            async { false },
            || oneshot::channel::<bool>().1,
            WAIT,
        ));
        assert!(is_permission(result));
    }

    #[test]
    fn the_channel_carries_the_first_answer_from_any_clone_or_thread() {
        let (answer, rx) = answer_channel();
        let other = answer.clone();
        std::thread::spawn(move || other(true)).join().unwrap();
        answer(false);
        assert_eq!(run(rx), Ok(true));
    }

    #[test]
    fn an_answer_after_the_wait_gave_up_is_dropped_quietly() {
        let (answer, rx) = answer_channel();
        drop(rx);
        answer(true);
        answer(true);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_copied_block_delivers_its_answer() {
        use objc2::runtime::Bool;

        let (answer, rx) = answer_channel();
        let block = completion_block(answer);
        block.call((Bool::YES,));
        assert_eq!(run(rx), Ok(true));
    }
}
