//! Classify dropped paths so the UI can decide how to insert each one: an image
//! is bracketed-pasted (so Claude Code attaches it), everything else is typed
//! raw. Detection is by file CONTENT (magic bytes via `infer`), never by
//! extension — a mislabeled or extension-less image is still recognised, and a
//! directory or unreadable path never is.

/// For each path, whether it is an image file (by content). Directories,
/// non-images and unreadable paths are reported as `false`.
#[tauri::command]
pub fn paths_are_images(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| is_image_file(p)).collect()
}

fn is_image_file(path: &str) -> bool {
    matches!(
        infer::get_from_path(path),
        Ok(Some(kind)) if kind.matcher_type() == infer::MatcherType::Image
    )
}

#[cfg(test)]
mod tests {
    use super::is_image_file;
    use std::io::Write;

    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("kd-dnd-{}-{}", std::process::id(), name))
    }

    #[test]
    fn detects_a_png_by_content_even_with_a_wrong_extension() {
        let path = temp("fake.txt");
        // PNG signature — content says image, extension says text.
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
        std::fs::File::create(&path).unwrap().write_all(&png).unwrap();
        assert!(is_image_file(path.to_str().unwrap()));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_text_file_named_png_is_not_an_image() {
        let path = temp("not-really.png");
        std::fs::write(&path, b"plain text, definitely not an image").unwrap();
        assert!(!is_image_file(path.to_str().unwrap()));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_directory_is_not_an_image() {
        assert!(!is_image_file(std::env::temp_dir().to_str().unwrap()));
    }

    #[test]
    fn a_missing_path_is_not_an_image() {
        assert!(!is_image_file("/no/such/file/kd-xyz.png"));
    }
}
