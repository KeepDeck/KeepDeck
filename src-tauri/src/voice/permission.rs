//! The macOS microphone permission: checked before a capture opens a device,
//! and requested when it is missing.
//!
//! The permission is checked EXPLICITLY first: starting a CoreAudio stream
//! without it does not reliably fire the TCC prompt (dev builds in
//! particular) — the OS just delivers zeros. The AVCaptureDevice request is
//! what makes the prompt appear and the Settings entry exist. The press that
//! finds it missing fails with `permission` and fires the prompt; the user
//! answers it and presses again (decision: no waiting on the answer).

use super::error::VoiceError;
#[cfg(target_os = "macos")]
use super::error::VoiceErrorKind;

/// `Ok` when the app may record; otherwise fires the OS prompt and fails
/// with a `permission` error that names the fix.
pub(super) async fn ensure_microphone() -> Result<(), VoiceError> {
    #[cfg(target_os = "macos")]
    if !tauri_plugin_macos_permissions::check_microphone_permission().await {
        request_microphone_access();
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

/// Fire the AVCaptureDevice access request with a REAL completion block —
/// a nil completion handler (what the permissions plugin passes) fails to
/// raise the TCC dialog at least under a dev launch. The outcome lands in
/// the log so a granted/denied decision is visible without the Settings app.
#[cfg(target_os = "macos")]
fn request_microphone_access() {
    use block2::StackBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let media_type = NSString::from_str("soun");
    let handler = StackBlock::new(move |granted: Bool| {
        log::info!(
            "voice: microphone access request completed, granted={}",
            granted.as_bool()
        );
    })
    .copy();
    unsafe {
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: &*media_type,
            completionHandler: &*handler
        ];
    }
}
