//! Make sure the OS can tell who posts our notification banners.
//!
//! On macOS the stack under `tauri-plugin-notification` cannot post as
//! itself: `mac-notification-sys` swizzles `NSBundle.bundleIdentifier` and
//! answers with whatever `set_application` accepted, and the banner's icon is
//! that bundle's icon. Three details of that crate turn one miss into a
//! lasting, invisible defect:
//!
//! - the swizzle's fallback is `@"com.apple.Terminal"`, so a miss does not
//!   degrade to our own identity — it hands the banner Terminal's icon;
//! - `set_application` installs the swizzle BEFORE it checks anything, and
//!   stores the identifier only if LaunchServices resolves it, so a failed
//!   call leaves the hook armed over an empty value;
//! - it is wrapped in a `call_once` that the plugin fires lazily on the FIRST
//!   banner, discarding the result (`let _ = ...`). One badly timed attempt
//!   therefore mislabels every banner for the rest of the run, silently.
//!
//! The bad timing is real: our updater replaces the bundle and the app
//! relaunches from it while LaunchServices re-registers asynchronously. A
//! banner in that window burns the single attempt.
//!
//! We do not take that attempt away from the plugin — reaching into its
//! `call_once` would mean depending on a transitive crate's private static.
//! We remove the reason it fails instead: at startup, before anything can
//! notify, make sure LaunchServices resolves this bundle, registering it when
//! it does not. The plugin's later lookup then succeeds on its own. What the
//! app cannot fix, it says out loud — today that failure is written nowhere.

/// What startup could establish about our notification identity. Logged as
/// the run's record of a step whose failure is otherwise invisible.
#[derive(Debug, PartialEq, Eq)]
pub enum Identity {
    /// LaunchServices already knew the bundle.
    Known,
    /// It learned the bundle from us — the update-window race, caught.
    Registered,
    /// The bundle could not be made resolvable, so the plugin's lookup will
    /// miss and every banner this run wears Terminal's icon. Carries the
    /// registration's `OSStatus` (`Ok` when it reported success and the
    /// lookup still missed).
    Unresolvable { registered: Result<(), i32> },
}

/// The startup sequence, over injected effects so its order is testable
/// without LaunchServices: look first, register only on a miss, and confirm
/// by looking again rather than trusting the registration's own verdict.
fn establish<R, G>(identifier: &str, resolves: R, register: G) -> Identity
where
    R: Fn(&str) -> bool,
    G: FnOnce() -> Result<(), i32>,
{
    if resolves(identifier) {
        return Identity::Known;
    }
    let registered = register();
    if resolves(identifier) {
        Identity::Registered
    } else {
        Identity::Unresolvable { registered }
    }
}

/// Make this run's notification identity resolvable. macOS-only; a no-op
/// elsewhere, where the platform posts under the real application already.
pub fn prepare(identifier: &str) {
    #[cfg(target_os = "macos")]
    report(
        identifier,
        establish(
            identifier,
            macos::launch_services_resolves,
            macos::register_main_bundle,
        ),
    );
    #[cfg(not(target_os = "macos"))]
    let _ = identifier;
}

#[cfg(target_os = "macos")]
fn report(identifier: &str, outcome: Identity) {
    match outcome {
        Identity::Known => log::info!("notify: banners post as {identifier}"),
        Identity::Registered => log::info!(
            "notify: registered this bundle with LaunchServices, banners post as {identifier}"
        ),
        Identity::Unresolvable { registered } => log::error!(
            "notify: LaunchServices cannot resolve {identifier} (LSRegisterURL: {}) — \
             banners will wear Terminal's icon until the next launch",
            match registered {
                Ok(()) => "reported success".to_string(),
                Err(status) => format!("OSStatus {status}"),
            }
        ),
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    // Only the handful of C entry points this needs. `NSString` is toll-free
    // bridged to `CFStringRef`, and every CF value produced here is opaque to
    // us — we test it for NULL, hand it straight back, and release it.
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        /// `NULL` when LaunchServices knows no application with this id.
        /// The returned array is owned by the caller.
        fn LSCopyApplicationURLsForBundleIdentifier(
            bundle_id: &NSString,
            error: *mut *const c_void,
        ) -> *const c_void;
        /// `update: 0` — register only what is not registered yet.
        fn LSRegisterURL(url: *const c_void, update: u8) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        /// Borrowed — never released.
        fn CFBundleGetMainBundle() -> *const c_void;
        /// Owned by the caller.
        fn CFBundleCopyBundleURL(bundle: *const c_void) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    /// Exactly the lookup `mac-notification-sys` gates its swizzle on, asked
    /// while there is still time to act on the answer.
    pub(super) fn launch_services_resolves(identifier: &str) -> bool {
        let id = NSString::from_str(identifier);
        let urls = unsafe { LSCopyApplicationURLsForBundleIdentifier(&id, std::ptr::null_mut()) };
        if urls.is_null() {
            return false;
        }
        unsafe { CFRelease(urls) };
        true
    }

    /// Teach LaunchServices about the bundle we are running from. The URL
    /// comes from CoreFoundation rather than the executable's path, so a
    /// non-bundled build simply has none and is reported as unresolvable
    /// instead of registering a guess.
    pub(super) fn register_main_bundle() -> Result<(), i32> {
        let bundle = unsafe { CFBundleGetMainBundle() };
        if bundle.is_null() {
            return Err(0);
        }
        let url = unsafe { CFBundleCopyBundleURL(bundle) };
        if url.is_null() {
            return Err(0);
        }
        let status = unsafe { LSRegisterURL(url, 0) };
        unsafe { CFRelease(url) };
        if status == 0 {
            Ok(())
        } else {
            Err(status)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const ID: &str = "ai.keepdeck.desktop";

    #[test]
    fn a_bundle_launch_services_already_knows_is_left_alone() {
        let registered = Cell::new(false);
        let outcome = establish(
            ID,
            |_| true,
            || {
                registered.set(true);
                Ok(())
            },
        );
        assert_eq!(outcome, Identity::Known);
        assert!(
            !registered.get(),
            "a resolvable bundle must not be re-registered"
        );
    }

    #[test]
    fn an_unregistered_bundle_is_registered_and_confirmed() {
        let registered = Cell::new(false);
        let outcome = establish(
            ID,
            |_| registered.get(),
            || {
                registered.set(true);
                Ok(())
            },
        );
        assert_eq!(outcome, Identity::Registered);
    }

    /// A registration that claims success proves nothing — only the second
    /// lookup does. Trusting the status here would report a healthy identity
    /// for a run whose banners all wear Terminal's icon.
    #[test]
    fn a_successful_registration_that_does_not_resolve_is_still_a_failure() {
        let outcome = establish(ID, |_| false, || Ok(()));
        assert_eq!(outcome, Identity::Unresolvable { registered: Ok(()) });
    }

    #[test]
    fn a_failed_registration_carries_its_status() {
        let outcome = establish(ID, |_| false, || Err(-10814));
        assert_eq!(
            outcome,
            Identity::Unresolvable {
                registered: Err(-10814)
            }
        );
    }

    #[test]
    fn the_identifier_reaches_the_lookup() {
        let looked_up = Cell::new(String::new());
        establish(
            ID,
            |id| {
                looked_up.set(id.to_string());
                true
            },
            || Ok(()),
        );
        assert_eq!(looked_up.into_inner(), ID);
    }
}
