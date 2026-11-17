//! Keeping git blind to what is planted, and no further.
//!
//! A planting is hidden by exactly its own path, literal — never the folder
//! it sits in, which may hold the user's own files git must still see. A line
//! is added before the planting is published, so a planting is never visible
//! to git, even for a moment or after a crash. A line goes only when it is
//! provably needed by nothing: no place of this home names it, and in no
//! worktree of the repo does anything stand where it hides — another KeepDeck
//! home's planting there, which this ledger cannot see, keeps it. When that
//! cannot be decided (the worktrees will not list, an exclude file will not
//! write), the line stays and so does the place, to be tried again.
//!
//! A line an older build wrote hid a place's whole first segment, raw. It
//! goes with the last place that needs it, once no worktree holds what such a
//! place planted: for codex's old folder link, a link at its slot — anything
//! else under the folder is the user's, and hiding it was the harm; for a
//! file, anything at all at its slot.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::proof::{HISTORICAL_FOLDER_LINK, HISTORICAL_PLUGIN};
use super::registry::{slot, Held, Hidden, Place, What};
use crate::worktree_arm::{self, ExcludeLine, ExcludeRepo, Excluded};

/// One line a place needs, and what in a worktree it could still be hiding.
struct Need {
    line: ExcludeLine,
    common_dir: PathBuf,
    /// The place's path below any worktree's root.
    slot: PathBuf,
    /// Whether only a link standing at the slot keeps the line: the older
    /// builds' line for codex's whole-folder link, whose other occupants are
    /// the user's own.
    links_only: bool,
}

/// The lines of one pass, each repo and worktree list read once.
#[derive(Default)]
pub(super) struct Lines {
    repos: HashMap<String, Option<ExcludeRepo>>,
    roots: HashMap<PathBuf, Option<Vec<PathBuf>>>,
    /// How many exclude files this pass wrote.
    pub written: usize,
}

/// What [`Lines::release`] could not let go.
pub(super) type Kept = Vec<Held>;

impl Lines {
    fn repo(&mut self, cwd: &str) -> io::Result<Option<ExcludeRepo>> {
        if let Some(repo) = self.repos.get(cwd) {
            return Ok(repo.clone());
        }
        let repo = ExcludeRepo::of(Path::new(cwd))?;
        self.repos.insert(cwd.to_string(), repo.clone());
        Ok(repo)
    }

    /// The lines `place` needs: none for a folder, none outside any repo.
    fn needs(&mut self, place: &Place) -> io::Result<Vec<Need>> {
        let Some(repo) = self.repo(&place.cwd)? else { return Ok(Vec::new()) };
        let Some(first) = place.path.split('/').next() else { return Ok(Vec::new()) };
        let line = match (&place.what, place.hidden) {
            (What::Dir { .. }, _) => return Ok(Vec::new()),
            (_, Hidden::Exact) => repo.line(&Excluded { path: place.path.clone(), directory: false }),
            (_, Hidden::FirstSegment) => repo.legacy_line(first),
        };
        let links_only = place.hidden == Hidden::FirstSegment
            && matches!(place.what, What::Symlink { .. })
            && place.plugin == HISTORICAL_PLUGIN
            && slot(&place.path).as_deref() == Some(HISTORICAL_FOLDER_LINK);
        let common_dir = repo.common_dir().to_path_buf();
        Ok(vec![Need { line, common_dir, slot: repo.below_root(&place.path), links_only }])
    }

    /// Add every line `places` need — one write per repo, none when all are
    /// there already.
    pub fn ensure<'a>(&mut self, places: impl IntoIterator<Item = &'a Place>) -> io::Result<()> {
        let mut add = Vec::new();
        for place in places {
            add.extend(self.needs(place)?.into_iter().map(|need| need.line));
        }
        self.written += worktree_arm::update(&add, &[])?;
        Ok(())
    }

    /// Let the lines `gone` needed go where nothing else needs them, and
    /// answer the places whose lines could not be decided or taken out — the
    /// ledger keeps those ([`Place::line_left`]), to try again. A line is decided once, over every
    /// slot it hides: it goes only when none of them holds anything it could
    /// still be hiding, in any worktree. An entry a remaining place keeps
    /// hidden by its own line needs no other: an older build's line over a
    /// planting goes the moment the planting's exact line takes over.
    pub fn release(&mut self, gone: &[Held], remaining: &[&Place]) -> Kept {
        if gone.is_empty() {
            return Vec::new();
        }
        let keep_all = || gone.iter().map(|(ws, p)| (ws.clone(), p.clone().line_left())).collect();
        let mut needed: HashSet<ExcludeLine> = HashSet::new();
        let covered: HashSet<PathBuf> = remaining
            .iter()
            .filter(|p| !matches!(p.what, What::Dir { .. }))
            .map(|p| Path::new(&p.cwd).join(&p.path))
            .collect();
        for place in remaining {
            match self.needs(place) {
                Ok(needs) => needed.extend(needs.into_iter().map(|need| need.line)),
                // A remaining place whose lines cannot be read might need any
                // of them: nothing goes this pass.
                Err(e) => {
                    log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                    return keep_all();
                }
            }
        }
        let mut retained: Vec<usize> = Vec::new();
        let mut lines: HashMap<ExcludeLine, (Vec<Need>, Vec<usize>)> = HashMap::new();
        for (index, (_, place)) in gone.iter().enumerate() {
            match self.needs(place) {
                Ok(needs) => {
                    for need in needs.into_iter().filter(|need| !needed.contains(&need.line)) {
                        let (needs, owners) = lines.entry(need.line.clone()).or_default();
                        needs.push(need);
                        owners.push(index);
                    }
                }
                Err(e) => {
                    log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                    retained.push(index);
                }
            }
        }
        let mut remove = Vec::new();
        let mut removing: Vec<usize> = Vec::new();
        for (line, (needs, owners)) in lines {
            let mut standing = Some(false);
            for need in &needs {
                match self.standing(need, &covered) {
                    Some(false) => {}
                    Some(true) => standing = Some(true),
                    None => {
                        standing = None;
                        break;
                    }
                }
            }
            match standing {
                Some(false) => {
                    remove.push(line);
                    removing.extend(owners);
                }
                Some(true) => {}
                None => retained.extend(owners),
            }
        }
        match worktree_arm::update(&[], &remove) {
            Ok(written) => self.written += written,
            Err(e) => {
                log::warn!("cwd arming: taking exclude lines out failed: {e}");
                retained.extend(removing);
            }
        }
        retained.sort_unstable();
        retained.dedup();
        retained.into_iter().map(|index| (gone[index].0.clone(), gone[index].1.clone().line_left())).collect()
    }

    /// Whether anything a line could be hiding stands in some worktree of its
    /// repo, besides what `covered` names — None when the worktrees cannot be
    /// listed.
    fn standing(&mut self, need: &Need, covered: &HashSet<PathBuf>) -> Option<bool> {
        let roots = self
            .roots
            .entry(need.common_dir.clone())
            .or_insert_with(|| match keepdeck_git::worktree::roots(&need.common_dir) {
                Ok(roots) => Some(roots),
                Err(e) => {
                    log::warn!("cwd arming: listing the worktrees of {} failed: {e}", need.common_dir.display());
                    None
                }
            })
            .as_ref()?;
        let mut standing = false;
        for at in roots.iter().map(|root| root.join(&need.slot)).filter(|at| !covered.contains(at)) {
            match fs::symlink_metadata(at) {
                Ok(meta) if !need.links_only || meta.file_type().is_symlink() => standing = true,
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => {}
                Err(_) => return None,
            }
        }
        Some(standing)
    }
}
