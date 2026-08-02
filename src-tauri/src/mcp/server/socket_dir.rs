//! The directory the socket is served from — the transport's whole permission
//! model.
//!
//! Separate from [`super::claim`], which answers a different question: that one
//! arbitrates WHO may serve at a name, this one decides whether the place it
//! would serve from is ours and closed to everyone else. They are always called
//! in sequence, and that sequence is `start_at`'s invariant, not a reason to
//! keep two decisions in one file.

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Ready the socket's directory and return it. The directory IS the
/// transport's permission model (see paths::mcp_socket), so it is created
/// 0700 — never created loose and tightened after, which would leave a
/// window where another user can open a directory handle that survives the
/// chmod. A pre-existing directory is validated and retightened; a symlink
/// or a plain file in its place is refused rather than followed, so the
/// mode this code enforces is always the mode of the directory it serves
/// from.
pub(super) fn prepare_socket_dir(path: &Path) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "the MCP socket path has no directory".to_string())?;
    if let Some(home) = dir.parent() {
        std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "{} is a symlink — refusing to serve the MCP socket through it",
                    dir.display()
                ));
            }
            if !meta.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    Ok(dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::server::test_support::{temp_base, temp_sock};

    #[test]
    fn a_directory_this_call_creates_is_born_owner_only() {
        // Not "created loose, tightened after": a window there would let
        // another user open a dirfd that survives the chmod.
        let path = temp_base().join("mcp.sock");
        let dir = prepare_socket_dir(&path).expect("prepare");
        let mode = std::fs::metadata(&dir).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_loosened_leftover_directory_is_retightened() {
        let path = temp_sock();
        let parent = path.parent().expect("parent").to_path_buf();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755))
            .expect("loosen");
        prepare_socket_dir(&path).expect("prepare");
        let mode = std::fs::metadata(&parent).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_symlinked_socket_directory_is_refused() {
        // Following it would chmod — and serve from — whatever it points at.
        let base = temp_base();
        let real = base.join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        assert!(
            prepare_socket_dir(&link.join("mcp.sock")).is_err(),
            "a symlinked socket dir must be refused",
        );
    }
}
