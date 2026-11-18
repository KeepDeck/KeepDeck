//! Keeping git blind to what is planted, and no further.
//!
//! A planting is hidden by exactly its own path, literal — never the folder
//! it sits in, which may hold the user's own files git must still see. A line
//! is added before the planting is published, so a planting is never visible
//! to git, even for a moment or after a crash. A line goes only when it is
//! provably needed by nothing: no place of this home owes it, and in no
//! worktree of the repo does anything stand where it hides — another KeepDeck
//! home's planting there, which this ledger cannot see, keeps it. An entry a
//! place of this home keeps hidden by its own line is not such an occupant:
//! that line is written again in the same edit that takes the other out.
//!
//! A line that stays while its planting is gone is recorded as owed
//! ([`What::Line`]), with all it takes to let it go later — the repo, the
//! pattern, the entry — and nothing else: it claims no slot and touches no
//! file. It is tried again until nothing stands where it hides.
//!
//! A line an older build wrote hid a place's whole first segment, raw. It
//! goes with the last place that owes it, once no worktree holds what such a
//! place planted: for codex's old folder link, a link at its slot — anything
//! else under the folder is the user's, and hiding it was the harm; for any
//! other, anything at all at its slot.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::proof::{HISTORICAL_FOLDER_LINK, HISTORICAL_PLUGIN};
use super::registry::{slot, Held, Hidden, Owed, Place, What};
use crate::worktree_arm::{self, ExcludeLine, ExcludeRepo, Excluded};

/// The lines of one pass, each repo and worktree list read once.
#[derive(Default)]
pub(super) struct Lines {
    repos: HashMap<String, Option<ExcludeRepo>>,
    roots: HashMap<PathBuf, Option<Vec<PathBuf>>>,
    /// How many exclude files this pass wrote.
    pub written: usize,
}

impl Lines {
    fn repo(&mut self, cwd: &str) -> io::Result<Option<ExcludeRepo>> {
        if let Some(repo) = self.repos.get(cwd) {
            return Ok(repo.clone());
        }
        let repo = ExcludeRepo::of(Path::new(cwd))?;
        self.repos.insert(cwd.to_string(), repo.clone());
        Ok(repo)
    }

    /// The line `place` owes: the one recorded with it, or — for an older
    /// record, or one whose line could not be worked out when it was
    /// recorded — the one its directory gives now. None for a folder or
    /// outside any repo.
    fn owed(&mut self, place: &Place) -> io::Result<Option<Owed>> {
        match (&place.owed, &place.what) {
            (Some(owed), _) => Ok(Some(owed.clone())),
            (None, What::Dir { .. }) => Ok(None),
            (None, _) => self.owed_at(place),
        }
    }

    /// The line an entry at `place`'s path owes, hidden as its record says.
    fn owed_at(&mut self, place: &Place) -> io::Result<Option<Owed>> {
        let Some(repo) = self.repo(&place.cwd)? else { return Ok(None) };
        let line = match place.hidden {
            Hidden::Exact => repo.line(&Excluded { path: place.path.clone(), directory: false })?,
            Hidden::FirstSegment => {
                let Some(first) = place.path.split('/').next() else { return Ok(None) };
                repo.legacy_line(first)?
            }
        };
        let links_only = place.hidden == Hidden::FirstSegment
            && place.plugin == HISTORICAL_PLUGIN
            && slot(&place.path).as_deref() == Some(HISTORICAL_FOLDER_LINK);
        let exact = place.hidden == Hidden::Exact;
        Ok(Some(Owed { line, slot: repo.below_root(&place.path), links_only, exact }))
    }

    /// `place` with the line it owes written into it, as it is recorded: from
    /// then on, letting that line go never depends on its directory.
    pub fn stamp(&mut self, place: Place) -> io::Result<Place> {
        let owed = match place.what {
            What::Dir { .. } => None,
            _ => self.owed_at(&place)?,
        };
        Ok(Place { owed, ..place })
    }

    /// A reservation of the name `path` in `cwd` for a temporary, with the
    /// exact line that keeps git blind to it while it stands.
    pub fn reserve(&mut self, cwd: &str, plugin: &str, path: String) -> io::Result<Place> {
        self.stamp(Place {
            cwd: cwd.to_string(),
            plugin: plugin.to_string(),
            path,
            what: What::Temp { made: None },
            hidden: Hidden::Exact,
            owed: None,
        })
    }

    /// What stays recorded of `place` once nothing of it stands, while the
    /// line it owes cannot go yet: that line alone, which claims and changes
    /// nothing. None when it owes none. A line that cannot be worked out now
    /// stays owed all the same, to be worked out later — never as what the
    /// place was.
    pub fn line_left(&mut self, place: Place) -> Option<Place> {
        let owed = match self.owed(&place) {
            Ok(None) => return None,
            Ok(owed) => owed,
            Err(e) => {
                log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                None
            }
        };
        Some(Place { what: What::Line, owed, ..place })
    }

    /// Add every line `places` owe — one write per repo, none when all are
    /// there already.
    pub fn ensure<'a>(&mut self, places: impl IntoIterator<Item = &'a Place>) -> io::Result<()> {
        let mut add = Vec::new();
        for place in places {
            add.extend(self.owed(place)?.map(|owed| owed.line));
        }
        self.written += worktree_arm::update(&add, &[])?;
        Ok(())
    }

    /// Let the lines `gone` owed go where nothing else needs them, and answer
    /// what stays recorded: the line of each place whose line stays
    /// ([`Self::line_left`]). A line is decided once, over every entry it
    /// hides, and goes only when none of them holds anything it could still
    /// be hiding, in any worktree.
    pub fn release(&mut self, gone: Vec<Held>, remaining: &[&Place]) -> Vec<Held> {
        if gone.is_empty() {
            return Vec::new();
        }
        let mut needed: HashSet<ExcludeLine> = HashSet::new();
        // Each entry a remaining place keeps hidden by an exact line of its
        // own — a broad one hides what lies beside it too — by the repo and
        // the entry that line names, whatever its directory is called now.
        let mut covered: HashMap<(PathBuf, PathBuf), ExcludeLine> = HashMap::new();
        for place in remaining {
            match self.owed(place) {
                Ok(Some(owed)) => {
                    if owed.exact {
                        covered.insert((owed.line.common_dir().to_path_buf(), owed.slot.clone()), owed.line.clone());
                    }
                    needed.insert(owed.line);
                }
                Ok(None) => {}
                // A remaining place whose line cannot be read might need any
                // of them: nothing goes this pass.
                Err(e) => {
                    log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                    return self.left(gone, |_| true);
                }
            }
        }
        let mut stays: HashSet<usize> = HashSet::new();
        let mut lines: HashMap<ExcludeLine, (Vec<Owed>, Vec<usize>)> = HashMap::new();
        for (index, (_, place)) in gone.iter().enumerate() {
            match self.owed(place) {
                Ok(Some(owed)) if !needed.contains(&owed.line) => {
                    let (owed_here, owners) = lines.entry(owed.line.clone()).or_default();
                    owed_here.push(owed);
                    owners.push(index);
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                    stays.insert(index);
                }
            }
        }
        let mut remove = Vec::new();
        let mut install: HashSet<ExcludeLine> = HashSet::new();
        let mut removing: Vec<usize> = Vec::new();
        for (line, (owed, owners)) in lines {
            let mut through = Vec::new();
            let free = owed.iter().all(|one| self.standing(one, &covered, &mut through) == Some(false));
            if free {
                remove.push(line);
                install.extend(through);
                removing.extend(owners);
            } else {
                stays.extend(owners);
            }
        }
        let install: Vec<ExcludeLine> = install.into_iter().collect();
        match worktree_arm::update(&install, &remove) {
            Ok(written) => self.written += written,
            Err(e) => {
                log::warn!("cwd arming: taking exclude lines out failed: {e}");
                stays.extend(removing);
            }
        }
        self.left(gone, |index| stays.contains(&index))
    }

    /// The line left of each of `gone` that `stays` picks, by index.
    fn left(&mut self, gone: Vec<Held>, stays: impl Fn(usize) -> bool) -> Vec<Held> {
        gone.into_iter()
            .enumerate()
            .filter(|(index, _)| stays(*index))
            .filter_map(|(_, (ws, place))| self.line_left(place).map(|place| (ws, place)))
            .collect()
    }

    /// Whether anything `owed` could be hiding stands in some worktree of its
    /// repo — None when the worktrees cannot be listed. An entry `covered`
    /// names — this repo, this very entry — is hidden in every worktree by an
    /// exact line of its own: that line goes in `through`, to be written with
    /// the edit that lets this one go.
    fn standing(
        &mut self,
        owed: &Owed,
        covered: &HashMap<(PathBuf, PathBuf), ExcludeLine>,
        through: &mut Vec<ExcludeLine>,
    ) -> Option<bool> {
        let common_dir = owed.line.common_dir();
        if let Some(own) = covered.get(&(common_dir.to_path_buf(), owed.slot.clone())) {
            through.push(own.clone());
            return Some(false);
        }
        let roots = self
            .roots
            .entry(common_dir.to_path_buf())
            .or_insert_with(|| match keepdeck_git::worktree::roots(common_dir) {
                Ok(roots) => Some(roots),
                Err(e) => {
                    log::warn!("cwd arming: listing the worktrees of {} failed: {e}", common_dir.display());
                    None
                }
            })
            .as_ref()?;
        let mut standing = false;
        for at in roots.iter().map(|root| root.join(&owed.slot)) {
            match fs::symlink_metadata(&at) {
                Ok(meta) if !owed.links_only || meta.file_type().is_symlink() => standing = true,
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => {}
                Err(_) => return None,
            }
        }
        Some(standing)
    }
}
