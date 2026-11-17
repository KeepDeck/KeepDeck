//! What KeepDeck manages in pane directories: one manifest per workspace
//! (`cwd-arms/<ws>.json`), listing the PLACES it planted — never, on its own,
//! the proof that what stands there now is still ours. Proof is read from the
//! disk each time ([`super::proof`]); a place says where to look, and for a
//! file, what exactly was put there.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs_beneath::Identity;
use crate::state::write_atomic;

/// One place KeepDeck manages: a path relative to a pane directory, for one
/// plugin, of one workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Place {
    /// The directory's real path (older records may hold another spelling;
    /// they are read as the real one, see [`read`]).
    pub cwd: String,
    pub plugin: String,
    pub path: String,
    #[serde(flatten)]
    pub what: What,
    /// How git is kept blind to it — absent in records older builds wrote,
    /// which hid the path's whole first segment.
    #[serde(default)]
    pub hidden: Hidden,
}

/// What stands at a place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum What {
    /// A link. Whether one standing there is ours is read from where it
    /// points; `target` survives only in records older builds wrote.
    Symlink {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
    },
    /// A file — with its receipt, or none in a record an older build wrote,
    /// which leaves the file there unprovable and so never touched.
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<Receipt>,
    },
    /// A directory KeepDeck made on the way to a planting, exactly this one.
    Dir { identity: Identity },
}

/// What exactly KeepDeck put at a file place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub state: Landing,
    /// The file it is: the temporary it was written as, renamed into place.
    pub identity: Identity,
    /// The sha256 of what it holds.
    pub digest: String,
    /// The temporary's name beside the place, while `Prepared`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temp: Option<String>,
    /// The file this one replaces, while `Prepared` over one of ours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<Box<Landed>>,
}

/// A file KeepDeck landed: which one, holding what.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Landed {
    pub identity: Identity,
    pub digest: String,
}

/// Whether a file was confirmed in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Landing {
    /// Written, recorded, maybe not yet renamed into place: proves nothing
    /// until the place is seen holding exactly this file.
    Prepared,
    /// Seen in place, exactly this file.
    Active,
}

/// How a place keeps git blind to itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Hidden {
    /// The path's whole first segment, raw — what builds before this one
    /// wrote, and what their records (which name no way) read as.
    #[default]
    FirstSegment,
    /// Exactly the path, literal (`planted` in this change's interim builds).
    #[serde(alias = "planted")]
    Exact,
}

/// A place, with the workspace whose record holds it.
pub(super) type Held = (String, Place);

impl Place {
    /// Whether this place names the same entry as `path` in `cwd`.
    pub fn at(&self, cwd: &str, path: &str) -> bool {
        self.cwd == cwd && same_entry(Path::new(cwd), &self.path, path)
    }
}

/// Two relative paths in one directory name the same entry when they are
/// spelled alike ignoring case, or when both exist as one entry on disk (a
/// Unicode spelling the volume folds). Cautious by design: on a
/// case-sensitive volume `a` and `A` are two files, and this still calls them
/// one — refusing a name is better than writing over another planting.
pub(super) fn same_entry(cwd: &Path, a: &str, b: &str) -> bool {
    a == b || a.to_lowercase() == b.to_lowercase() || same_file(&cwd.join(a), &cwd.join(b))
}

fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// A directory as one spelling: its real path while it exists, else as
/// written — so a cwd reached through a symlink, or spelled with `..`, is the
/// cwd it is.
pub(super) fn canonical(dir: &str) -> String {
    fs::canonicalize(dir).map_or_else(|_| dir.to_string(), |real| real.to_string_lossy().into_owned())
}

/// Every workspace's places, by workspace id, and the workspaces whose
/// manifest will not read — whose claims nobody can know.
pub(super) struct Ledger {
    pub root: PathBuf,
    pub places: Vec<(String, Vec<Place>)>,
    pub unreadable: Vec<String>,
}

impl Ledger {
    pub fn read(root: &Path) -> io::Result<Self> {
        let mut ledger = Ledger { root: root.to_path_buf(), places: Vec::new(), unreadable: Vec::new() };
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ledger),
            Err(e) => return Err(e),
        };
        let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let Some(ws) = name.strip_suffix(".json") else { continue };
            match read(root, ws) {
                Ok(places) => ledger.places.push((ws.to_string(), places)),
                Err(e) => {
                    log::warn!("cwd arming: the record of {ws} is unreadable: {e}");
                    ledger.unreadable.push(ws.to_string());
                }
            }
        }
        Ok(ledger)
    }

    /// Whether every manifest reads: only then may anything that already
    /// stands be changed — an unreadable one could be the claim on it.
    pub fn whole(&self) -> bool {
        self.unreadable.is_empty()
    }

    pub fn of(&self, ws: &str) -> Vec<Place> {
        self.places.iter().find(|(id, _)| id == ws).map(|(_, places)| places.clone()).unwrap_or_default()
    }

    pub fn all(&self) -> impl Iterator<Item = (&str, &Place)> {
        self.places.iter().flat_map(|(ws, places)| places.iter().map(move |p| (ws.as_str(), p)))
    }

    /// Record `places` as the workspace's whole manifest, unless that is
    /// what it already says.
    pub fn write(&mut self, ws: &str, places: Vec<Place>) -> io::Result<()> {
        let current = self.of(ws);
        if current.len() == places.len() && current.iter().all(|p| places.contains(p)) {
            return Ok(());
        }
        write(&self.root, ws, &places)?;
        match self.places.iter_mut().find(|(id, _)| id == ws) {
            Some((_, slot)) => *slot = places,
            None => self.places.push((ws.to_string(), places)),
        }
        Ok(())
    }

    /// Set a dead workspace's unreadable manifest aside, never deleting it:
    /// its plantings stay where they are, unclaimed.
    pub fn set_aside(&self, ws: &str) -> io::Result<()> {
        fs::rename(manifest(&self.root, ws), self.root.join(format!("{ws}.json.unreadable")))
    }
}

pub(super) fn manifest(root: &Path, ws: &str) -> PathBuf {
    root.join(format!("{ws}.json"))
}

fn read(root: &Path, ws: &str) -> io::Result<Vec<Place>> {
    let mut places: Vec<Place> = match fs::read(manifest(root, ws)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
        Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    for place in &mut places {
        place.cwd = canonical(&place.cwd);
    }
    Ok(places)
}

fn write(root: &Path, ws: &str, places: &[Place]) -> io::Result<()> {
    let path = manifest(root, ws);
    if places.is_empty() {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    fs::create_dir_all(root)?;
    write_atomic(&path, &serde_json::to_vec(places).map_err(io::Error::other)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_an_older_build_wrote_reads_as_a_legacy_place() {
        let tmp = tempfile::tempdir().unwrap();
        let older = r#"[
            {"cwd":"/r","plugin":"p","path":".agents/skills","kind":"symlink","target":"/s"},
            {"cwd":"/r","plugin":"k","path":".kimi-code/mcp.json","kind":"file"},
            {"cwd":"/r","plugin":"p","path":".l","kind":"symlink","target":"/s","hidden":"planted"}
        ]"#;
        fs::write(manifest(tmp.path(), "ws-1"), older).unwrap();
        let places = read(tmp.path(), "ws-1").unwrap();
        assert_eq!(places[0].what, What::Symlink { target: Some("/s".into()) });
        assert_eq!(places[0].hidden, Hidden::FirstSegment);
        assert_eq!(places[1].what, What::File { receipt: None }, "a file no receipt proves");
        assert_eq!(places[2].hidden, Hidden::Exact, "this branch's interim name for exact");
    }

    #[test]
    fn a_manifest_is_written_only_when_it_changes_and_goes_when_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::read(tmp.path()).unwrap();
        let place = Place {
            cwd: "/r".into(),
            plugin: "p".into(),
            path: ".l".into(),
            what: What::Symlink { target: None },
            hidden: Hidden::Exact,
        };
        ledger.write("ws-1", vec![place.clone()]).unwrap();
        assert!(manifest(tmp.path(), "ws-1").exists());
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let unchanged = ledger.write("ws-1", vec![place]);
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o755)).unwrap();
        unchanged.unwrap();
        ledger.write("ws-1", Vec::new()).unwrap();
        assert!(!manifest(tmp.path(), "ws-1").exists());
    }

    #[test]
    fn an_unreadable_manifest_is_named_and_makes_the_ledger_partial() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(manifest(tmp.path(), "ws-9"), "not json").unwrap();
        let ledger = Ledger::read(tmp.path()).unwrap();
        assert_eq!(ledger.unreadable, vec!["ws-9"]);
        assert!(!ledger.whole());
    }
}
