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
//!   staging. It may give way to a real folder, so links can go inside it.

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
        Roots {
            roots: [home.join("plugin-workspaces").join(plugin).join(ws), home.join("skills").join("staging").join(ws)],
        }
    }

    /// Whether a link written as `text` points into these directories: an
    /// absolute path, plain components only, under one of them.
    pub fn hold(&self, text: &Path) -> bool {
        plain(text) && self.roots.iter().any(|root| text.starts_with(root) && text != root.as_path())
    }
}

/// An absolute path of plain components: nothing a reader resolves first.
fn plain(text: &Path) -> bool {
    let mut parts = text.components();
    matches!(parts.next(), Some(Component::RootDir)) && parts.all(|part| matches!(part, Component::Normal(_)))
}

/// Where older builds linked codex's whole skills folder.
pub(super) const HISTORICAL_FOLDER_LINK: &str = ".agents/skills";

/// Whether `text` is the link older builds made at [`HISTORICAL_FOLDER_LINK`]:
/// to `<home>/skills/staging/<some workspace>/skills`, exactly.
pub(super) fn historical_folder_link(home: &Path, path: &str, text: &Path) -> bool {
    let staging = home.join("skills").join("staging");
    let Ok(rest) = text.strip_prefix(&staging) else { return false };
    let rest: Vec<Component> = rest.components().collect();
    path == HISTORICAL_FOLDER_LINK
        && plain(text)
        && matches!(rest.as_slice(), [Component::Normal(_), Component::Normal(skills)] if *skills == "skills")
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

    #[test]
    fn a_link_is_ours_only_into_this_plugins_and_workspaces_directories() {
        let roots = Roots::of(Path::new("/home/kd"), "keepdeck.codex", "ws-1");
        assert!(roots.hold(Path::new("/home/kd/skills/staging/ws-1/skills/review")));
        assert!(roots.hold(Path::new("/home/kd/plugin-workspaces/keepdeck.codex/ws-1/conf")));
        for theirs in [
            "/home/kd/skills/staging/ws-2/skills/review",
            "/home/kd/plugin-workspaces/keepdeck.kimi/ws-1/conf",
            "/home/kd-dev/skills/staging/ws-1/skills/review",
            "/home/kd/skills/staging/ws-1/../ws-2/skills",
            "/home/kd/skills/staging/ws-10/skills",
            "skills/staging/ws-1/skills",
            "/home/kd/skills/staging/ws-1",
            "/Users/me/dotfiles/skills/review",
        ] {
            assert!(!roots.hold(Path::new(theirs)), "{theirs}");
        }
    }

    #[test]
    fn only_the_historical_folder_link_into_this_homes_staging_is_recognized() {
        let home = Path::new("/home/kd");
        let at = HISTORICAL_FOLDER_LINK;
        assert!(historical_folder_link(home, at, Path::new("/home/kd/skills/staging/ws-7/skills")));
        assert!(!historical_folder_link(home, ".agents", Path::new("/home/kd/skills/staging/ws-7/skills")));
        for other in [
            "/home/kd/skills/staging/ws-7/skills/review",
            "/home/kd/skills/staging/ws-7/other",
            "/home/kd/skills/staging/ws-7/../../x/skills",
            "/home/kd-dev/skills/staging/ws-7/skills",
            "/Users/me/skills",
        ] {
            assert!(!historical_folder_link(home, at, Path::new(other)), "{other}");
        }
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
