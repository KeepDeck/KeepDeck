//! Whether what stands at a place is KeepDeck's — always read from the disk,
//! never from a record alone. The one authority every change asks.
//!
//! - A LINK is ours when it points into the plugin's own directories for its
//!   workspace: the plugin's workspace directory, or the workspace's skills
//!   staging. Where it points is what KeepDeck chose; a link anywhere else —
//!   the user's, another workspace's, another KeepDeck home's — is not ours.
//! - A FILE is ours when it is exactly the file KeepDeck landed: the same
//!   entry (device, inode and birth time — an inode reused by a later file is
//!   not this one) holding the same bytes. A copy with equal bytes is not
//!   ours; neither is a file a record names without a receipt (an older
//!   build's), which therefore is never changed.
//! - One historical case is recognized as such: the link older builds made
//!   for codex to the whole `.agents/skills` folder, into this home's skills
//!   staging. It may give way to a real folder — for codex only — so links can
//!   go inside it.
//!
//! A link's text is judged as written AND on the disk: the part of it that
//! exists must be itself, no link on the way leading somewhere else — so a
//! path that only reads as ours never passes.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest as _, Sha256};

use super::registry::Landed;
use crate::fs_beneath::Identity;

/// The directories one plugin's links in one workspace point into.
pub(super) struct Roots {
    roots: [PathBuf; 2],
}

impl Roots {
    /// `home` is KeepDeck's home, real path.
    pub fn of(home: &Path, plugin: &str, ws: &str) -> Self {
        Roots { roots: [crate::plugin_workspaces::path_in(home, plugin, ws), crate::skills::staging_in(home, ws)] }
    }

    /// Whether a link written as `text` points into these directories: an
    /// absolute path, plain components only, one of them or under one, its
    /// existing part truly where it reads. The one contract for a link KeepDeck
    /// makes and one it later finds: what this admits it also recognizes.
    pub fn hold(&self, text: &Path) -> bool {
        plain(text) && self.roots.iter().any(|root| text.starts_with(root)) && truly(text)
    }
}

/// Whether the existing part of `text` — the longest of its ancestors there,
/// or itself — is where it reads: no link on it leading elsewhere. What does
/// not exist (a skill since dropped) cannot lead anywhere; what cannot be
/// looked at might, so it is not judged ours.
fn truly(text: &Path) -> bool {
    for at in text.ancestors() {
        match at.symlink_metadata() {
            Ok(_) => return std::fs::canonicalize(at).is_ok_and(|real| real == at),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
    }
    false
}

/// An absolute path of plain components: nothing a reader resolves first.
fn plain(text: &Path) -> bool {
    let mut parts = text.components();
    matches!(parts.next(), Some(Component::RootDir)) && parts.all(|part| matches!(part, Component::Normal(_)))
}

/// The plugin whose older builds linked a whole folder, and where.
pub(super) const HISTORICAL_PLUGIN: &str = "keepdeck.codex";
pub(super) const HISTORICAL_FOLDER_LINK: &str = ".agents/skills";

/// Whether `text`, at `path` for `plugin`, is the link older builds made for
/// codex at [`HISTORICAL_FOLDER_LINK`]: to some workspace's staged skills
/// view in this home, exactly, and truly there.
pub(super) fn historical_folder_link(home: &Path, plugin: &str, path: &str, text: &Path) -> bool {
    plugin == HISTORICAL_PLUGIN
        && super::registry::slot(path).as_deref() == Some(HISTORICAL_FOLDER_LINK)
        && plain(text)
        && crate::skills::is_view_in(home, text)
        && truly(text)
}

/// The sha256 of `bytes`, as a receipt records it.
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// Whether the file seen at a place — its identity, when its volume keeps
/// one, and its digest, when it could be read — is exactly `landed`.
pub(super) fn is_landed(landed: &Landed, identity: Option<Identity>, digest: Option<&str>) -> bool {
    identity == Some(landed.identity) && digest == Some(landed.digest.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(ino: u64, born: i64) -> Identity {
        Identity { dev: 1, ino, born: (born, 0) }
    }

    /// A home of real directories: `skills/staging/ws-1/skills`, and a
    /// plugin's workspace directory.
    fn home() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(tmp.path()).unwrap().join("kd");
        std::fs::create_dir_all(home.join("skills/staging/ws-1/skills")).unwrap();
        std::fs::create_dir_all(home.join("plugin-workspaces/keepdeck.codex/ws-1")).unwrap();
        (tmp, home)
    }

    #[test]
    fn a_link_is_ours_only_into_this_plugins_and_workspaces_directories() {
        let (_tmp, home) = home();
        let roots = Roots::of(&home, "keepdeck.codex", "ws-1");
        for ours in [
            "skills/staging/ws-1/skills/review",
            "skills/staging/ws-1/skills/dropped-since",
            "plugin-workspaces/keepdeck.codex/ws-1",
            "plugin-workspaces/keepdeck.codex/ws-1/conf",
        ] {
            assert!(roots.hold(&home.join(ours)), "{ours}");
        }
        for theirs in [
            "skills/staging/ws-2/skills/review",
            "plugin-workspaces/keepdeck.kimi/ws-1/conf",
            "skills/staging/ws-1/../ws-2/skills",
            "skills/staging/ws-10/skills",
        ] {
            assert!(!roots.hold(&home.join(theirs)), "{theirs}");
        }
        for theirs in ["skills/staging/ws-1/skills", "/Users/me/dotfiles/skills/review"] {
            assert!(!roots.hold(Path::new(theirs)), "{theirs}");
        }
    }

    #[test]
    fn a_link_that_only_reads_as_ours_through_a_link_on_its_way_is_not() {
        let (tmp, home) = home();
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join("skills/staging/ws-1/skills/detour")).unwrap();
        let roots = Roots::of(&home, "keepdeck.codex", "ws-1");
        assert!(!roots.hold(&home.join("skills/staging/ws-1/skills/detour/review")));
    }

    #[test]
    fn a_target_that_cannot_be_looked_at_is_not_judged_ours() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, home) = home();
        let locked = home.join("skills/staging/ws-1/skills/locked");
        std::fs::create_dir_all(locked.join("review")).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let held = Roots::of(&home, "keepdeck.codex", "ws-1").hold(&locked.join("review"));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!held, "what lies past a folder that will not open is unknown");
    }

    #[test]
    fn only_codexs_historical_folder_link_into_this_homes_staging_is_recognized() {
        let (_tmp, home) = home();
        let (codex, at) = (HISTORICAL_PLUGIN, HISTORICAL_FOLDER_LINK);
        let historical = home.join("skills/staging/ws-1/skills");
        assert!(historical_folder_link(&home, codex, at, &historical));
        assert!(historical_folder_link(&home, codex, ".agents//skills", &historical), "one slot, any spelling");
        assert!(!historical_folder_link(&home, "keepdeck.kimi", at, &historical), "codex's alone");
        assert!(!historical_folder_link(&home, codex, ".agents", &historical));
        for other in ["skills/staging/ws-1/skills/review", "skills/staging/ws-1/other"] {
            assert!(!historical_folder_link(&home, codex, at, &home.join(other)), "{other}");
        }
        assert!(!historical_folder_link(&home, codex, at, Path::new("/Users/me/skills")));
    }

    #[test]
    fn a_file_is_the_landed_one_only_by_its_identity_and_its_bytes_together() {
        let landed = Landed { identity: id(7, 100), digest: digest(b"ours") };
        assert!(is_landed(&landed, Some(id(7, 100)), Some(&digest(b"ours"))));
        let same_bytes_other_file = Some(id(8, 100));
        assert!(!is_landed(&landed, same_bytes_other_file, Some(&digest(b"ours"))));
        let reused_inode = Some(id(7, 101));
        assert!(!is_landed(&landed, reused_inode, Some(&digest(b"ours"))));
        assert!(!is_landed(&landed, Some(id(7, 100)), Some(&digest(b"edited"))));
        assert!(!is_landed(&landed, None, Some(&digest(b"ours"))), "an unknown identity proves nothing");
        assert!(!is_landed(&landed, Some(id(7, 100)), None), "unread bytes prove nothing");
    }
}
