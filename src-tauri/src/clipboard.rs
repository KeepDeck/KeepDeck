//! Bridge a clipboard image into a pane. A PTY is a byte stream — image BYTES
//! can't be pasted into a CLI — so, like iTerm / Warp / AnyClaude, the
//! pasteboard bitmap is saved to a temp PNG and the pane pastes the file's
//! PATH instead; image-aware CLIs (Claude Code) read the file from there.

use tauri_plugin_clipboard_manager::ClipboardExt;

/// Save the clipboard's image (if any) to a uniquely-named temp PNG and
/// return its absolute path. `None` when the clipboard holds no image — the
/// common case for a text-less paste — or when encoding/writing fails.
#[tauri::command]
pub fn clipboard_image_to_temp(app: tauri::AppHandle) -> Option<String> {
    let image = app.clipboard().read_image().ok()?;
    save_rgba_png(image.rgba(), image.width(), image.height())
}

/// Encode raw RGBA pixels as a PNG under the system temp dir. The filename
/// carries an app-identifiable prefix (`keepdeck_clipboard_<nanos>.png`) so a
/// user who finds one can tell where it came from. `None` when the pixel
/// buffer doesn't match the dimensions or PNG can't encode the image (e.g.
/// zero-sized).
fn save_rgba_png(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("keepdeck_clipboard_{nanos}.png"));
    img.save(&path).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::save_rgba_png;

    #[test]
    fn round_trips_pixels_through_the_temp_png() {
        // 2x1: one red pixel, one semi-transparent blue.
        let rgba = [255, 0, 0, 255, 0, 0, 255, 128];
        let path = save_rgba_png(&rgba, 2, 1).expect("png saved");

        let name = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .expect("utf-8 filename");
        assert!(name.starts_with("keepdeck_clipboard_"), "name: {name}");
        assert!(name.ends_with(".png"), "name: {name}");

        let img = image::open(&path).expect("decodable png").to_rgba8();
        assert_eq!(img.dimensions(), (2, 1));
        assert_eq!(img.into_raw(), rgba);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_a_buffer_that_does_not_match_the_dimensions() {
        assert_eq!(save_rgba_png(&[1, 2, 3], 2, 2), None);
    }

    #[test]
    fn rejects_a_zero_sized_image() {
        assert_eq!(save_rgba_png(&[], 0, 0), None);
    }
}
