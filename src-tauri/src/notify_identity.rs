//! Make sure the OS can tell who posts our notification banners. macOS only —
//! `lib.rs` compiles this module solely for that target.
//!
//! The stack under `tauri-plugin-notification` cannot post as itself:
//! `mac-notification-sys` swizzles `NSBundle.bundleIdentifier` and answers with
//! whatever `set_application` accepted, and the banner's icon is that bundle's
//! icon. Three details of that crate turn one miss into a lasting, invisible
//! defect:
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
//! We do not take that attempt away from the plugin — reaching into its
//! `call_once` would mean depending on a transitive crate's private static.
//! We remove the reason it fails instead: at startup, make sure LaunchServices
//! resolves this bundle, registering it when it does not. The plugin's later
//! lookup then succeeds on its own. What the app cannot fix, it says out loud —
//! that failure is otherwise written nowhere.
//!
//! WHICH RACE THIS CLOSES, precisely: the updater replaces the bundle and the
//! app relaunches from it while LaunchServices re-registers asynchronously, so
//! the NEW process's first banner could land before the bundle is resolvable.
//! Running at that process's startup is what closes it.
//!
//! What it does NOT close: a long-lived process that has posted no banner yet when
//! the bundle is swapped underneath it. Its `prepare` already ran and passed;
//! if its first-ever banner falls inside the replacement window, the plugin's
//! one attempt still burns. Fixing that needs a retry the plugin does not
//! offer, so the honest scope is "every launch starts resolvable".

/// Why registering the bundle did not succeed. A plain `OSStatus` cannot say
/// this: `LSRegisterURL` was not always reached, and its "not attempted"
/// sentinel would have to be `0` — which is `noErr`, the SUCCESS code.
#[derive(Debug, PartialEq, Eq)]
pub enum RegisterFailure {
    /// CoreFoundation gave us no bundle URL — `LSRegisterURL` never ran.
    NoBundleUrl,
    /// `LSRegisterURL` ran and refused, with this `OSStatus`.
    Status(i32),
}

/// What startup could establish about our notification identity. Logged as
/// the run's record of a step whose failure is otherwise invisible.
#[derive(Debug, PartialEq, Eq)]
pub enum Identity {
    /// LaunchServices already knew the bundle.
    Known,
    /// It learned the bundle from us — the update-window race, caught.
    Registered,
    /// The bundle could not be made resolvable, so the plugin's lookup will
    /// miss and every banner this run wears Terminal's icon.
    Unresolvable {
        /// `Ok` when registration reported success and the lookup still
        /// missed — the case that makes the second lookup worth doing.
        registered: Result<(), RegisterFailure>,
    },
}

/// The startup sequence, over injected effects so its order is testable
/// without LaunchServices: look first, register only on a miss, and confirm
/// by looking again rather than trusting the registration's own verdict.
fn establish<R, G>(identifier: &str, resolves: R, register: G) -> Identity
where
    R: Fn(&str) -> bool,
    G: FnOnce() -> Result<(), RegisterFailure>,
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

/// Make this run's notification identity resolvable.
pub fn prepare(identifier: &str) {
    // A dev build never posts under our identity: the plugin hardcodes
    // `com.apple.Terminal` there (tauri-plugin-notification desktop.rs), so
    // preparing ours would touch LaunchServices for nothing and then report
    // on an identity nobody uses — in both directions, since `Known` would
    // claim health while every dev banner wears Terminal's icon. Mirror the
    // plugin's own predicate rather than `debug_assertions`: `is_dev()` is
    // exactly the branch it takes.
    if tauri::is_dev() {
        log::debug!("notify: dev build — banners post as com.apple.Terminal by design");
        return;
    }
    let outcome = establish(
        identifier,
        macos::launch_services_resolves,
        macos::register_main_bundle,
    );
    let (level, message) = report_line(identifier, &outcome);
    log::log!(level, "{message}");
}

/// The module's only committed output, as a value — so the level and the
/// wording are testable, which matters for a module whose whole job is to
/// make a silent failure audible.
fn report_line(identifier: &str, outcome: &Identity) -> (log::Level, String) {
    match outcome {
        Identity::Known => (
            log::Level::Info,
            format!("notify: banners post as {identifier}"),
        ),
        Identity::Registered => (
            log::Level::Info,
            format!(
                "notify: registered this bundle with LaunchServices, \
                 banners post as {identifier}"
            ),
        ),
        Identity::Unresolvable { registered } => (
            log::Level::Error,
            format!(
                "notify: LaunchServices cannot resolve {identifier} ({}) — \
                 banners will wear Terminal's icon until the next launch",
                match registered {
                    Ok(()) => "LSRegisterURL reported success".to_string(),
                    Err(RegisterFailure::NoBundleUrl) =>
                        "no bundle URL, nothing was registered".to_string(),
                    Err(RegisterFailure::Status(status)) =>
                        format!("LSRegisterURL: OSStatus {status}"),
                }
            ),
        ),
    }
}

mod macos {
    use super::RegisterFailure;
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    // Only the handful of C entry points this needs. `NSString` is toll-free
    // bridged to `CFStringRef`, and every CF value produced here is opaque to
    // us — we test it for NULL, hand it straight back, and release it.
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        /// `NULL` when LaunchServices knows no application with this id.
        /// The returned array is owned by the caller. A NULL `error` out-param
        /// is explicitly allowed (LSInfo.h: "If you are not interested in this
        /// information, pass NULL").
        fn LSCopyApplicationURLsForBundleIdentifier(
            bundle_id: &NSString,
            error: *mut *const c_void,
        ) -> *const c_void;
        /// `update: 0` — register only what is not registered yet. `Boolean`
        /// is one byte.
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

    /// Teach LaunchServices about the bundle we are running from.
    ///
    /// Both NULL guards are DEFENSIVE, not a filter: for a process that is not
    /// inside a `.app`, CoreFoundation synthesizes a main bundle rooted at the
    /// executable's directory, so this would hand `LSRegisterURL` a plain
    /// directory and collect its refusal (`-10811`) rather than returning
    /// early. Nothing is silently registered in that case — `LSRegisterURL` is
    /// not recursive, so a directory that merely CONTAINS bundles registers
    /// none of them — but the call is pointless, which is one more reason
    /// `prepare` returns before it in dev builds, the only unbundled runs we
    /// have.
    pub(super) fn register_main_bundle() -> Result<(), RegisterFailure> {
        let bundle = unsafe { CFBundleGetMainBundle() };
        if bundle.is_null() {
            return Err(RegisterFailure::NoBundleUrl);
        }
        let url = unsafe { CFBundleCopyBundleURL(bundle) };
        if url.is_null() {
            return Err(RegisterFailure::NoBundleUrl);
        }
        let status = unsafe { LSRegisterURL(url, 0) };
        unsafe { CFRelease(url) };
        if status == 0 {
            Ok(())
        } else {
            Err(RegisterFailure::Status(status))
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
        let outcome = establish(ID, |_| false, || Err(RegisterFailure::Status(-10811)));
        assert_eq!(
            outcome,
            Identity::Unresolvable {
                registered: Err(RegisterFailure::Status(-10811))
            }
        );
    }

    #[test]
    fn a_resolvable_identity_is_reported_at_info_and_names_itself() {
        let (level, message) = report_line(ID, &Identity::Known);
        assert_eq!(level, log::Level::Info);
        assert!(message.contains(ID), "{message}");
    }

    #[test]
    fn catching_the_update_race_is_reported_as_a_registration() {
        let (level, message) = report_line(ID, &Identity::Registered);
        assert_eq!(level, log::Level::Info);
        assert!(message.contains("registered"), "{message}");
    }

    /// The one line a maintainer acts on, so it must be findable (error level)
    /// and must name the consequence, not just the failure.
    #[test]
    fn an_unresolvable_identity_is_reported_at_error_with_its_consequence() {
        let (level, message) = report_line(
            ID,
            &Identity::Unresolvable {
                registered: Err(RegisterFailure::Status(-10811)),
            },
        );
        assert_eq!(level, log::Level::Error);
        assert!(message.contains("-10811"), "{message}");
        assert!(message.contains("Terminal"), "{message}");
    }

    /// `0` is `noErr`: a "not attempted" case that printed `OSStatus 0` would
    /// send the reader looking up a SUCCESS code for a call that never ran.
    #[test]
    fn a_registration_that_never_ran_never_prints_a_status_code() {
        let (_, message) = report_line(
            ID,
            &Identity::Unresolvable {
                registered: Err(RegisterFailure::NoBundleUrl),
            },
        );
        assert!(message.contains("nothing was registered"), "{message}");
        assert!(!message.contains("OSStatus"), "{message}");
    }

    /// The three states must not read alike: a successful-but-useless
    /// registration is a different diagnosis from one that never ran.
    #[test]
    fn the_three_unresolvable_reasons_read_differently() {
        let line = |registered| report_line(ID, &Identity::Unresolvable { registered }).1;
        let reported_success = line(Ok(()));
        let never_ran = line(Err(RegisterFailure::NoBundleUrl));
        let refused = line(Err(RegisterFailure::Status(-10811)));
        assert_ne!(reported_success, never_ran);
        assert_ne!(never_ran, refused);
        assert_ne!(reported_success, refused);
    }
}
