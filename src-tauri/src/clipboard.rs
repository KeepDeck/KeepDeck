//! Bridge a clipboard image into a pane. A PTY is a byte stream — image BYTES
//! can't be pasted into a CLI — so, like iTerm / Warp / AnyClaude, the
//! pasteboard bitmap is saved to a temp PNG and the pane pastes the file's
//! PATH instead; image-aware CLIs (Claude Code) read the file from there.

use image::ImageEncoder;
use std::{
    fs::{self, OpenOptions},
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri_plugin_clipboard_manager::ClipboardExt;

const FILE_PREFIX: &str = "keepdeck_clipboard_";
const FILE_SUFFIX: &str = ".png";
const CREATE_ATTEMPTS: usize = 8;

/// Save the clipboard's image (if any) to a uniquely-named temp PNG and
/// return its absolute path. `None` when the clipboard holds no image — the
/// common case for a text-less paste — or when encoding/writing fails.
///
/// `(async)` so the PNG encode (often multi-MB) + disk write run on Tauri's
/// worker pool, not the main thread — a large image paste must not freeze the UI.
#[tauri::command(async)]
pub fn clipboard_image_to_temp(app: tauri::AppHandle) -> Option<String> {
    let image = app.clipboard().read_image().ok()?;
    save_rgba_png(image.rgba(), image.width(), image.height())
}

/// Reap `keepdeck_clipboard_*` PNGs left by previous runs. A paste's temp
/// file can't be deleted inline — the CLI in the pane reads it
/// asynchronously — so each paste leaks one (often multi-MB) PNG until this
/// startup sweep. Mirrors the session-spool sweep, but filtered by our
/// filename prefix: the system temp dir is shared, not app-owned.
pub fn sweep_stale_clipboard_files() {
    sweep_dir(&std::env::temp_dir());
}

/// [`sweep_stale_clipboard_files`] over an explicit dir (testable core).
fn sweep_dir(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Encode raw RGBA pixels as a PNG under the system temp dir. The filename
/// carries an app-identifiable prefix (`keepdeck_clipboard_<uuid>.png`) so a
/// user who finds one can tell where it came from. `None` when the pixel
/// buffer doesn't match the dimensions or PNG can't encode the image (e.g.
/// zero-sized).
fn save_rgba_png(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    let path = save_rgba_png_in(rgba, width, height, &std::env::temp_dir())?;
    Some(path.to_string_lossy().into_owned())
}

/// [`save_rgba_png`] over an explicit dir (testable core).
fn save_rgba_png_in(rgba: &[u8], width: u32, height: u32, dir: &Path) -> Option<PathBuf> {
    for _ in 0..CREATE_ATTEMPTS {
        let path = dir.join(format!(
            "{FILE_PREFIX}{}{FILE_SUFFIX}",
            uuid::Uuid::new_v4()
        ));
        match save_rgba_png_at(rgba, width, height, &path) {
            Ok(()) => return Some(path),
            Err(SavePngError::AlreadyExists) => continue,
            Err(SavePngError::Failed) => return None,
        }
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
enum SavePngError {
    AlreadyExists,
    Failed,
}

/// Encode one PNG without ever replacing an existing path. Invalid images
/// are rejected before the file is opened; failed encodes leave no partial
/// file behind.
fn save_rgba_png_at(rgba: &[u8], width: u32, height: u32, path: &Path) -> Result<(), SavePngError> {
    if width == 0 || height == 0 {
        return Err(SavePngError::Failed);
    }
    let image =
        image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or(SavePngError::Failed)?;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(SavePngError::AlreadyExists)
        }
        Err(_) => return Err(SavePngError::Failed),
    };

    let encoded = image::codecs::png::PngEncoder::new(file).write_image(
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgba8,
    );
    if encoded.is_err() {
        let _ = fs::remove_file(path);
        return Err(SavePngError::Failed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        save_rgba_png_at, save_rgba_png_in, sweep_dir, SavePngError, FILE_PREFIX, FILE_SUFFIX,
    };

    #[test]
    fn sweep_reaps_only_our_stale_pngs() {
        let dir = std::env::temp_dir().join(format!(
            "kd-clipboard-sweep-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ours = dir.join("keepdeck_clipboard_123.png");
        let foreign = dir.join("someone-elses.png");
        let near_miss = dir.join("keepdeck_clipboard_notes.txt");
        std::fs::write(&ours, "png").unwrap();
        std::fs::write(&foreign, "png").unwrap();
        std::fs::write(&near_miss, "txt").unwrap();

        sweep_dir(&dir);

        assert!(!ours.exists(), "our stale PNG must be reaped");
        assert!(foreign.exists(), "foreign files must be untouched");
        assert!(near_miss.exists(), "only .png with our prefix is ours");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_pixels_through_the_temp_png() {
        let dir = tempfile::tempdir().unwrap();
        // 2x1: one red pixel, one semi-transparent blue.
        let rgba = [255, 0, 0, 255, 0, 0, 255, 128];
        let path = save_rgba_png_in(&rgba, 2, 1, dir.path()).expect("png saved");

        assert_eq!(path.parent(), Some(dir.path()));
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("utf-8 filename");
        assert!(name.starts_with(FILE_PREFIX), "name: {name}");
        assert!(name.ends_with(FILE_SUFFIX), "name: {name}");
        let uuid = name
            .strip_prefix(FILE_PREFIX)
            .and_then(|name| name.strip_suffix(FILE_SUFFIX))
            .and_then(|uuid| uuid::Uuid::parse_str(uuid).ok())
            .expect("filename carries a UUID");
        assert_eq!(uuid.get_version_num(), 4);

        let img = image::open(&path).expect("decodable png").to_rgba8();
        assert_eq!(img.dimensions(), (2, 1));
        assert_eq!(img.into_raw(), rgba);
    }

    #[test]
    fn rejects_a_buffer_that_does_not_match_the_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(save_rgba_png_in(&[1, 2, 3], 2, 2, dir.path()), None);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn zero_sized_image_leaves_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("keepdeck_clipboard_fresh.png");

        assert_eq!(
            save_rgba_png_at(&[], 0, 0, &fresh),
            Err(SavePngError::Failed)
        );
        assert!(!fresh.exists());

        let occupied = dir.path().join("keepdeck_clipboard_occupied.png");
        std::fs::write(&occupied, "winner").unwrap();
        assert_eq!(
            save_rgba_png_at(&[], 0, 0, &occupied),
            Err(SavePngError::Failed)
        );
        assert_eq!(std::fs::read(&occupied).unwrap(), b"winner");
    }

    #[test]
    fn candidate_collision_never_overwrites_the_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keepdeck_clipboard_forced.png");
        let red = [255, 0, 0, 255];
        let blue = [0, 0, 255, 255];

        save_rgba_png_at(&red, 1, 1, &path).expect("first writer wins");
        assert_eq!(
            save_rgba_png_at(&blue, 1, 1, &path),
            Err(SavePngError::AlreadyExists)
        );

        let image = image::open(path)
            .expect("winner remains decodable")
            .to_rgba8();
        assert_eq!(image.into_raw(), red);
    }
}
