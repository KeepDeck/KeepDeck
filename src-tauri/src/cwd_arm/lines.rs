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

use super::registry::{Held, Hidden, Place, What};
use crate::worktree_arm::{self, ExcludeLine, ExcludeRepo, Excluded};

/// One line a place needs, and what in a worktree it could still be hiding.
struct Need {
    line: ExcludeLine,
    common_dir: PathBuf,
    /// The place's path below any worktree's root.
    slot: PathBuf,
    /// Whether only a link standing at the slot keeps the line.
    links_only: bool,
}

/// The lines of one pass, each repo and worktree list read once.
#[derive(Default)]
pub(super) struct Lines {
    repos: HashMap<String, Option<ExcludeRepo>>,
    roots: HashMap<PathBuf, Option<Vec<PathBuf>>>,
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

    /// The lines `place` needs: none for a folder, none outside any repo.
    fn needs(&mut self, place: &Place) -> io::Result<Vec<Need>> {
        let Some(repo) = self.repo(&place.cwd)? else { return Ok(Vec::new()) };
        let Some(first) = place.path.split('/').next() else { return Ok(Vec::new()) };
        let line = match (&place.what, place.hidden) {
            (What::Dir { .. }, _) => return Ok(Vec::new()),
            (_, Hidden::Exact) => repo.line(&Excluded { path: place.path.clone(), directory: false }),
            (_, Hidden::FirstSegment) => repo.legacy_line(first),
        };
        let links_only = place.hidden == Hidden::FirstSegment && matches!(place.what, What::Symlink { .. });
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
        worktree_arm::update(&add, &[])
    }

    /// Let the lines `gone` needed go where nothing else needs them, and
    /// answer the places whose lines could not be decided or taken out — the
    /// ledger keeps those, to try again.
    pub fn release(&mut self, gone: &[Held], remaining: &[&Place]) -> Vec<Held> {
        let mut needed: HashSet<ExcludeLine> = HashSet::new();
        for place in remaining {
            match self.needs(place) {
                Ok(needs) => needed.extend(needs.into_iter().map(|need| need.line)),
                // A remaining place whose lines cannot be read might need any
                // of them: nothing goes this pass.
                Err(e) => {
                    log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                    return gone.to_vec();
                }
            }
        }
        let mut retained = Vec::new();
        let mut remove = Vec::new();
        for (ws, place) in gone {
            let needs = match self.needs(place) {
                Ok(needs) => needs,
                Err(e) => {
                    log::warn!("cwd arming: exclude lookup for {} failed: {e}", place.cwd);
                    retained.push((ws.clone(), place.clone()));
                    continue;
                }
            };
            let mut undecided = false;
            for need in needs {
                if needed.contains(&need.line) || remove.contains(&need.line) {
                    continue;
                }
                match self.standing(&need) {
                    Some(false) => remove.push(need.line),
                    Some(true) => {}
                    None => undecided = true,
                }
            }
            if undecided {
                retained.push((ws.clone(), place.clone()));
            }
        }
        if let Err(e) = worktree_arm::update(&[], &remove) {
            log::warn!("cwd arming: taking exclude lines out failed: {e}");
            return gone.to_vec();
        }
        retained
    }

    /// Whether anything a line could be hiding stands in some worktree of its
    /// repo — None when the worktrees cannot be listed.
    fn standing(&mut self, need: &Need) -> Option<bool> {
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
        for root in roots {
            match fs::symlink_metadata(root.join(&need.slot)) {
                Ok(meta) if !need.links_only || meta.file_type().is_symlink() => standing = true,
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => {}
                Err(_) => return None,
            }
        }
        Some(standing)
    }
}
