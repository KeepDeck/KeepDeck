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

/// Whether the pointer is over the window's content. `true` where the OS
/// cannot say: an unknown changes nothing.
#[tauri::command]
pub fn pointer_in_window(window: tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::{NSPoint, NSRect};

        let Ok(ns_window) = window.ns_window() else {
            return true;
        };
        let ns_window = ns_window as *mut AnyObject;
        if ns_window.is_null() {
            return true;
        }
        unsafe {
            let frame: NSRect = msg_send![ns_window, frame];
            let content: NSRect = msg_send![ns_window, contentRectForFrameRect: frame];
            let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
            within(
                mouse.x,
                mouse.y,
                content.origin.x,
                content.origin.y,
                content.size.width,
                content.size.height,
            )
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::within;

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
}
