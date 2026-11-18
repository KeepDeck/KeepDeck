//! What KeepDeck manages in pane directories: one manifest per workspace
//! (`cwd-arms/<ws>.json`), listing the PLACES it planted — never, on its own,
//! the proof that what stands there now is still ours. Proof is read from the
//! disk each time ([`super::proof`]); a place says where to look, and for a
//! file, what exactly was put there. Beside its plantings a record holds what
//! a pass still owes: an exclude line kept after its planting went, which
//! claims and changes nothing, and a name reserved for a temporary before it
//! is made, so a crash never leaves one no record names.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs_beneath::Identity;
use crate::state::write_atomic;
use crate::worktree_arm::ExcludeLine;

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
    /// The exclude line it owes, as written when it was recorded: what lets
    /// that line go again whatever becomes of the directory. Absent in older
    /// records, and in one whose line could not be worked out yet — then it
    /// is worked out from `cwd` when it can be.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owed: Option<Owed>,
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
    /// Nothing of ours stands here, and nothing here is ever changed or
    /// claimed: only the exclude line still owed — for a planting gone, one
    /// that never landed, a temporary — kept until it can be let go.
    Line,
    /// A name reserved for a staged file before it is made. The reservation
    /// alone proves nothing about what stands at it: a file there goes only
    /// when it is the one `made` records. Anything else is left as it is.
    Temp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        made: Option<Identity>,
    },
}

/// An exclude line owed, with all it takes to let it go again — even once
/// the directory it was owed for is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Owed {
    pub line: ExcludeLine,
    /// The entry it hides, below the root of any worktree of its repo.
    pub slot: PathBuf,
    /// Whether only a link standing there keeps it: the older builds' line
    /// for codex's whole-folder link, whose other occupants are the user's.
    pub links_only: bool,
    /// Whether it hides exactly its entry, and nothing beside it.
    pub exact: bool,
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    /// Whether this place claims the slot `path` names in `cwd`.
    pub fn at(&self, cwd: &str, path: &str) -> bool {
        self.cwd == cwd && self.claim().is_some_and(|claim| Some(claim) == slot(path))
    }

    /// This place's slot in its directory.
    pub fn slot(&self) -> Option<String> {
        slot(&self.path)
    }

    /// The slot this place claims for its plugin: one a planting or a folder
    /// of ours stands in. An owed line or a reserved name claims nothing.
    pub fn claim(&self) -> Option<String> {
        match self.what {
            What::Line | What::Temp { .. } => None,
            _ => self.slot(),
        }
    }
}

/// The one spelling of the slot a relative path names in its directory: its
/// plain components joined by `/`, case folded and in one Unicode form — a
/// case-insensitive volume makes `mcp.json` and `MCP.json` one file, APFS and
/// HFS+ make a composed `é` and a decomposed one the same name, and on a
/// volume that tells them apart this still calls them one: refusing a name
/// is better than planting over another. `None` for a path that is not a
/// slot (empty, absolute, leaving the directory). Two hard links are two
/// names, so two slots.
pub(super) fn slot(path: &str) -> Option<String> {
    use unicode_normalization::UnicodeNormalization as _;
    super::relative_parts(path).map(|parts| parts.join("/").to_lowercase().nfd().collect())
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
    /// what it already says. Answers whether it was written.
    pub fn write(&mut self, ws: &str, places: Vec<Place>) -> io::Result<bool> {
        let current = self.of(ws);
        if current.len() == places.len() && current.iter().all(|p| places.contains(p)) {
            return Ok(false);
        }
        write(&self.root, ws, &places)?;
        match self.places.iter_mut().find(|(id, _)| id == ws) {
            Some((_, slot)) => *slot = places,
            None => self.places.push((ws.to_string(), places)),
        }
        Ok(true)
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
            owed: None,
        };
        assert!(ledger.write("ws-1", vec![place.clone()]).unwrap());
        assert!(manifest(tmp.path(), "ws-1").exists());
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let unchanged = ledger.write("ws-1", vec![place]);
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!unchanged.unwrap(), "nothing written");
        ledger.write("ws-1", Vec::new()).unwrap();
        assert!(!manifest(tmp.path(), "ws-1").exists());
    }

    #[test]
    fn a_slot_is_one_spelling_of_a_path_and_never_a_path_out() {
        assert_eq!(slot("cfg/./link"), Some("cfg/link".into()));
        assert_eq!(slot("cfg//Link"), Some("cfg/link".into()));
        assert_eq!(slot("CFG/link"), slot("cfg/LINK"));
        assert_eq!(slot("cfg/caf\u{e9}"), slot("cfg/cafe\u{301}"), "composed and decomposed: one name");
        assert_eq!(slot("cfg/CAF\u{c9}"), slot("cfg/cafe\u{301}"));
        assert_ne!(slot("cfg/link"), slot("cfg/link2"));
        for out in ["", "/abs", "../x", "a/../b"] {
            assert_eq!(slot(out), None, "{out:?}");
        }
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
