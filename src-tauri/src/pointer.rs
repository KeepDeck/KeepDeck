//! Where the pointer is, asked of the OS — for the moments the web view
//! hears nothing: a pointer leaving the window fast through its edge sends
//! the page no event at all (WKWebView).
//!
//! Not Tauri's `cursor_position`: on a desk of monitors with different
//! scales it reports the pointer scaled by ANOTHER monitor's factor (seen
//! live: ×2 over a ×1 window), so it never matched the window's box. Cocoa
//! gives the pointer and the window's frame in ONE space — global points,
//! bottom-left origin — and both are read from it here.

/// A point inside a box — origin at its low corner, the far edges outside.
pub fn within(x: f64, y: f64, left: f64, bottom: f64, width: f64, height: f64) -> bool {
    x >= left && x < left + width && y >= bottom && y < bottom + height
}

/// The pointer in the content's own space — CSS pixels from its top-left
/// corner — given both in Cocoa's (global points, bottom-left origin), or
/// `None` off the content.
pub fn content_point(
    x: f64,
    y: f64,
    left: f64,
    bottom: f64,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    within(x, y, left, bottom, width, height).then_some((x - left, bottom + height - y))
}

/// Where the pointer is over the window's content, read once: `None` where
/// the OS cannot say, `Some(None)` off it — out of its box, or in it under
/// another app's window — `Some(Some(point))` on it, in the content's own
/// space (`content_point`).
#[cfg(target_os = "macos")]
fn pointer_on_content(window: &tauri::WebviewWindow) -> Option<Option<(f64, f64)>> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSInteger, NSPoint, NSRect};

    let ns_window = window.ns_window().ok()? as *mut AnyObject;
    if ns_window.is_null() {
        return None;
    }
    unsafe {
        let frame: NSRect = msg_send![ns_window, frame];
        let content: NSRect = msg_send![ns_window, contentRectForFrameRect: frame];
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let Some(point) = content_point(
            mouse.x,
            mouse.y,
            content.origin.x,
            content.origin.y,
            content.size.width,
            content.size.height,
        ) else {
            return Some(None);
        };
        // In our box, but under another app's window: not on us.
        let ours: NSInteger = msg_send![ns_window, windowNumber];
        let top: NSInteger = msg_send![
            class!(NSWindow),
            windowNumberAtPoint: mouse,
            belowWindowWithWindowNumber: 0 as NSInteger
        ];
        Some((top == ours).then_some(point))
    }
}

#[cfg(not(target_os = "macos"))]
fn pointer_on_content(window: &tauri::WebviewWindow) -> Option<Option<(f64, f64)>> {
    let _ = window;
    None
}

/// Whether the pointer is over the window's content — over its box, and
/// with no other window on top of it there. `None` where the OS cannot
/// say: the caller stops asking.
///
/// SYNC ON PURPOSE: Tauri runs a sync command on the main thread, and
/// AppKit (NSWindow's frame, the window list) is main-thread only. Made
/// `async`, it would move to a worker thread and these calls with it.
#[tauri::command]
pub fn pointer_in_window(window: tauri::WebviewWindow) -> Option<bool> {
    pointer_on_content(&window).map(|on| on.is_some())
}

/// The pointer on the window's content, as `pointer_on_window` answers it.
#[derive(serde::Serialize)]
pub struct PointerOnWindow {
    /// CSS pixels from the content's top-left corner.
    x: f64,
    y: f64,
    /// A mouse button is held: the click that brought the window forward
    /// may not be over yet, and the page hears neither its down nor its up.
    pressed: bool,
}

/// Whether any mouse button is held, asked of the OS.
#[cfg(target_os = "macos")]
fn buttons_held() -> bool {
    use objc2::{class, msg_send};
    use objc2_foundation::NSUInteger;
    let held: NSUInteger = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    held != 0
}

#[cfg(not(target_os = "macos"))]
fn buttons_held() -> bool {
    false
}

/// Where the pointer is on the window's content, in CSS pixels from its
/// top-left corner, and whether a button is held — for a window coming to
/// the front under a pointer that has not moved, which the web view does
/// not hear. `None` off the content, or where the OS cannot say: either
/// way, nothing to tell.
///
/// SYNC ON PURPOSE, as `pointer_in_window`.
#[tauri::command]
pub fn pointer_on_window(window: tauri::WebviewWindow) -> Option<PointerOnWindow> {
    let (x, y) = pointer_on_content(&window).flatten()?;
    Some(PointerOnWindow {
        x,
        y,
        pressed: buttons_held(),
    })
}

#[cfg(test)]
mod tests {
    use super::{content_point, within};

    #[test]
    fn holds_a_point_inside_its_near_edges_included() {
        assert!(within(100.0, 50.0, 100.0, 50.0, 800.0, 600.0));
        assert!(within(500.0, 300.0, 100.0, 50.0, 800.0, 600.0));
    }

    #[test]
    fn drops_a_point_past_any_edge_the_far_edges_outside() {
        assert!(!within(99.0, 300.0, 100.0, 50.0, 800.0, 600.0));
        assert!(!within(900.0, 300.0, 100.0, 50.0, 800.0, 600.0));
        assert!(!within(500.0, 49.0, 100.0, 50.0, 800.0, 600.0));
        assert!(!within(500.0, 650.0, 100.0, 50.0, 800.0, 600.0));
    }

    #[test]
    fn turns_a_point_on_the_content_into_its_own_space_top_left_origin() {
        // Content 800×600 with its low-left corner at (100, 50), Cocoa's space.
        assert_eq!(
            content_point(100.0, 649.0, 100.0, 50.0, 800.0, 600.0),
            Some((0.0, 1.0))
        );
        assert_eq!(
            content_point(130.0, 50.0, 100.0, 50.0, 800.0, 600.0),
            Some((30.0, 600.0))
        );
        assert_eq!(content_point(99.0, 300.0, 100.0, 50.0, 800.0, 600.0), None);
    }
}
