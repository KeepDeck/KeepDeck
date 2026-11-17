//! One lifecycle for every change the engine makes: what is decided, from the
//! ledger and the disk, before anything is touched; then the changes, in an
//! order where a crash at any point leaves nothing of the user's harmed and
//! nothing of ours unrecorded that a record could not later find.
//!
//! An arming pass, in order:
//!
//! 1. Decide each declaration from what stands now, and name every
//!    temporary it will make.
//! 2. Set up, changing nothing that stands: first the record of what the
//!    pass will owe — the new links, each new file's line, each temporary's
//!    reserved name — then every exclude line all of it needs. If either
//!    will not go, NOTHING that stands changes this pass: no planting, no
//!    take-back, no line let go, no record promoted.
//! 3. Clear each link older builds left on the way, once.
//! 4. Make the folders on the way and stage the files, and record them as
//!    prepared.
//! 5. Publish: only into an empty name, or over what is still provably ours.
//!    A file is active once seen in place as staged.
//! 6. Settle the record: a declared slot keeps what stood until a new planting
//!    took its place; an undeclared one is taken back, with every reserved
//!    name's leftover; lines nothing needs go.
//!
//! A crash between any two steps leaves only what a record names: a folder
//! made on the way, which an empty folder of ours is, is the one thing that
//! may stay behind unnamed.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use super::disk::{self, Reach, Slot};
use super::lines::Lines;
use super::proof::{self, Roots};
use super::registry::{canonical, slot, Held, Hidden, Landed, Landing, Ledger, Place, Receipt, What};
use super::{relative_parts, ArmRefusal, CwdArm, CwdArmReport, CAPS};
use crate::fs_beneath::{self as fsb, Publish};

/// The mode a planted file is made with: what an editor would make it.
const PLANTED_FILE_MODE: u32 = 0o644;

const UNREADABLE: &str = "KeepDeck's record of what it planted here could not be read";
const UNWRITABLE: &str = "KeepDeck's record of what it plants here could not be written";
const UNHIDDEN: &str = "this could not be kept from git — nothing was planted";

/// What one pass did, by the measures its budget is held to: an unchanged
/// set is observed once per entry, hashes nothing, and writes nothing.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct Stats {
    pub observed: usize,
    pub digested: usize,
    pub manifests_written: usize,
    pub excludes_written: usize,
}

/// What one admitted declaration is to become.
enum Want {
    Link(PathBuf),
    File { bytes: Vec<u8>, digest: String },
}

struct Admitted {
    index: usize,
    /// The declared path in its one spelling ([`slot`], case kept).
    path: String,
    parts: Vec<String>,
    want: Want,
}

/// What is done with one admitted declaration.
enum Act {
    /// Already exactly as declared.
    Keep,
    /// Into an empty slot — after a link older builds left on the way gave
    /// way, when one did.
    Create { clear: Option<(String, PathBuf)> },
    /// Over what stands there, which is ours: a link (by where it points) or
    /// a file (as landed).
    Replace { ours: Slot, previous: Option<Landed> },
}

/// One declaration carried through the pass.
struct Planting {
    admitted: Admitted,
    act: Act,
    /// The temporary a file is staged as, named before anything is made.
    temp: Option<OsString>,
    dir: Option<File>,
    staged: Option<fsb::Staged>,
    refused: Option<String>,
}

impl Planting {
    fn leaf(&self) -> &OsStr {
        OsStr::new(self.admitted.parts.last().expect("a declared path has a name"))
    }
    /// The temporary's own path below the cwd, while it has one.
    fn temp_path(&self) -> Option<String> {
        let temp = self.temp.as_ref()?;
        let parent = &self.admitted.parts[..self.admitted.parts.len() - 1];
        Some(parent.iter().cloned().chain([temp.to_string_lossy().into_owned()]).collect::<Vec<_>>().join("/"))
    }
    fn changes(&self) -> bool {
        self.refused.is_none() && !matches!(self.act, Act::Keep)
    }
}

/// Arm `cwd` with exactly `arms` for `plugin`, on behalf of workspace `ws`.
pub(super) fn arm(
    root: &Path,
    home: &Path,
    plugin: &str,
    ws: &str,
    cwd: &str,
    arms: &[CwdArm],
    allowed: &[PathBuf],
) -> (CwdArmReport, Stats) {
    let mut stats = Stats::default();
    let refuse_all = |reason: &str| CwdArmReport {
        armed: Vec::new(),
        refused: arms.iter().map(|arm| ArmRefusal { path: arm.path().to_string(), reason: reason.into() }).collect(),
    };
    let content: usize =
        arms.iter().map(|arm| if let CwdArm::File { content, .. } = arm { content.len() } else { 0 }).sum();
    if content > CAPS.total_content_max_bytes {
        return (refuse_all("this agent declares more than KeepDeck plants in one folder"), stats);
    }
    let (arms, past) = arms.split_at(arms.len().min(CAPS.entries_max));
    let (cwd, cwd_fd) = match open_cwd(cwd) {
        Ok(Some(open)) => open,
        Ok(None) => return (refuse_all("this directory no longer exists"), stats),
        Err(e) => return (refuse_all(&e.to_string()), stats),
    };
    let cwd = cwd.as_str();
    let mut ledger = match Ledger::read(root) {
        Ok(ledger) if !ledger.unreadable.iter().any(|id| id == ws) => ledger,
        Ok(_) => return (refuse_all(UNREADABLE), stats),
        Err(e) => {
            log::warn!("cwd arming: reading the records failed: {e}");
            return (refuse_all(UNREADABLE), stats);
        }
    };
    let whole = ledger.whole();
    let roots = Roots::of(home, plugin, ws);
    let allowed: Vec<PathBuf> = allowed.iter().filter_map(|dir| std::fs::canonicalize(dir).ok()).collect();
    let theirs: HashSet<String> =
        ledger.all().filter(|(_, p)| p.cwd == cwd && p.plugin != plugin).filter_map(|(_, p)| p.claim()).collect();

    let mut refusals: Vec<Option<String>> = vec![None; arms.len()];
    let admitted = admit(arms, &theirs, &allowed, &roots, &mut refusals);
    let declared: HashSet<String> = arms.iter().filter_map(|arm| slot(arm.path())).collect();

    // This plugin's places here, settled from what stands.
    let (here, elsewhere): (Vec<Place>, Vec<Place>) =
        ledger.of(ws).into_iter().partition(|p| p.cwd == cwd && p.plugin == plugin);
    let mut forgotten: Vec<Held> = Vec::new();
    let mut here: Vec<Place> = here
        .into_iter()
        .filter_map(|place| match settle(&cwd_fd, place.clone()) {
            Ok(Settled::Place(place)) => Some(place),
            Ok(Settled::Forget(place)) => {
                forgotten.push((ws.to_string(), place));
                None
            }
            Err(e) => {
                log::warn!("cwd arming: settling {cwd}/{} failed: {e}", place.path);
                Some(place)
            }
        })
        .collect();
    let dirs: Vec<Place> = take(&mut here, |p| matches!(p.what, What::Dir { .. }));
    let owed: Vec<Place> = take(&mut here, |p| matches!(p.what, What::Line { .. }));
    let leftovers: Vec<Place> = take(&mut here, |p| matches!(p.what, What::Temp { .. }));
    let mut by_slot: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, place) in here.iter().enumerate() {
        if let Some(key) = place.slot() {
            by_slot.entry(key).or_default().push(index);
        }
    }
    // An exact place over an older build's one for the same entry.
    let place_at = |key: &str| -> Option<&Place> {
        by_slot.get(key)?.iter().map(|i| &here[*i]).max_by_key(|p| p.hidden == Hidden::Exact)
    };

    // 1. Decide, and name every temporary.
    let mut plantings: Vec<Planting> = Vec::new();
    for admitted in admitted {
        let key = slot(&admitted.path).expect("an admitted path is a slot");
        let decided = decide(&cwd_fd, home, &roots, &ledger, plugin, cwd, whole, &admitted, place_at(&key), &mut stats);
        match decided {
            Ok(act) => {
                let temp = match (&admitted.want, &act) {
                    (Want::File { .. }, Act::Create { .. } | Act::Replace { .. }) | (Want::Link(_), Act::Replace { .. }) => {
                        Some(fsb::temporary_beside(OsStr::new(admitted.parts.last().expect("a path has a name"))))
                    }
                    _ => None,
                };
                plantings.push(Planting { admitted, act, temp, dir: None, staged: None, refused: None });
            }
            Err(reason) => refusals[admitted.index] = Some(reason),
        }
    }

    // 2. Set up: the record of what the pass will owe, then the lines.
    let mut lines = Lines::default();
    let recorded = |extra: &[Place]| -> Vec<Place> {
        elsewhere.iter().chain(&here).chain(&dirs).chain(&owed).chain(&leftovers).chain(extra).cloned().collect()
    };
    let mut setup: Result<(), &str> = Ok(());
    let mut intent: Vec<Place> = Vec::new();
    for planting in plantings.iter().filter(|p| p.changes()) {
        let path = planting.admitted.path.clone();
        let owes = match &planting.admitted.want {
            Want::Link(_) => Ok(Some(place(cwd, plugin, path, What::Symlink { target: None }))),
            Want::File { .. } => lines.owing(&exact(cwd, plugin, &planting.admitted)),
        };
        let reserved = planting.temp_path().map(|temp| lines.reserve(cwd, plugin, temp)).transpose();
        match (owes, reserved) {
            (Ok(owes), Ok(reserved)) => intent.extend(owes.into_iter().chain(reserved)),
            (Err(e), _) | (_, Err(e)) => {
                log::warn!("cwd arming: hiding {ws}'s plantings in {cwd} from git failed: {e}");
                setup = Err(UNHIDDEN);
            }
        }
    }
    if setup.is_ok() {
        match ledger.write(ws, dedup(recorded(&intent))) {
            Ok(wrote) => stats.manifests_written += usize::from(wrote),
            Err(e) => {
                log::warn!("cwd arming: recording {ws} failed: {e}");
                setup = Err(UNWRITABLE);
            }
        }
    }
    if setup.is_ok() {
        let exacts: Vec<Place> = plantings.iter().map(|p| exact(cwd, plugin, &p.admitted)).collect();
        let reservations = intent.iter().filter(|p| matches!(p.what, What::Temp { .. }));
        if let Err(e) = lines.ensure(exacts.iter().chain(reservations)) {
            log::warn!("cwd arming: hiding {ws}'s plantings in {cwd} from git failed: {e}");
            setup = Err(UNHIDDEN);
        }
    }
    if let Err(reason) = setup {
        for planting in plantings.iter_mut().filter(|p| p.changes()) {
            planting.refused = Some(reason.to_string());
        }
    }
    // Whether anything that stands may change this pass.
    let fence = whole && setup.is_ok();

    // 3. Clear each link older builds left on the way, once.
    let mut cleared: Vec<String> = Vec::new();
    let mut not_cleared: HashMap<String, String> = HashMap::new();
    for planting in plantings.iter_mut().filter(|p| p.changes()) {
        let Act::Create { clear: Some((at, link)) } = &planting.act else { continue };
        if cleared.contains(at) {
            continue;
        }
        let failed = match not_cleared.get(at) {
            Some(reason) => Some(reason.clone()),
            None => match clear_link(&cwd_fd, at, link) {
                Ok(()) => {
                    cleared.push(at.clone());
                    None
                }
                Err(e) => {
                    let reason = format!("{at} could not give way: {e}");
                    not_cleared.insert(at.clone(), reason.clone());
                    Some(reason)
                }
            },
        };
        planting.refused = failed;
    }

    // 4. Make the way and stage the files; record them as prepared.
    let mut made: Vec<Place> = Vec::new();
    let mut prepared: Vec<Place> = Vec::new();
    for planting in plantings.iter_mut().filter(|p| p.changes()) {
        let way = match disk::reach(&cwd_fd, &planting.admitted.parts, true) {
            Ok(Reach::Reached(way)) => way,
            Ok(Reach::Blocked { at, .. }) => {
                planting.refused = Some(format!("{at} here is not a directory"));
                continue;
            }
            Ok(Reach::Missing) => unreachable!("a way that makes folders is never missing one"),
            Err(e) => {
                planting.refused = Some(e.to_string());
                continue;
            }
        };
        made.extend(way.made.into_iter().map(|(path, identity)| place(cwd, plugin, path, What::Dir { identity })));
        if let (Want::File { bytes, digest }, Some(temp)) = (&planting.admitted.want, &planting.temp) {
            match fsb::stage_at(&way.dir, temp, bytes, PLANTED_FILE_MODE) {
                Ok(file) => {
                    let Some(identity) = file.identity else {
                        let _ = fsb::remove_at(&way.dir, &file.name, false);
                        planting.refused =
                            Some(format!("{} cannot be told apart from a later file on this volume", planting.admitted.path));
                        continue;
                    };
                    let previous = if let Act::Replace { previous, .. } = &planting.act { previous.clone() } else { None };
                    let receipt =
                        Receipt { state: Landing::Prepared, identity, digest: digest.clone(), previous: previous.map(Box::new) };
                    let what = What::File { receipt: Some(receipt) };
                    prepared.push(place(cwd, plugin, planting.admitted.path.clone(), what));
                    planting.staged = Some(file);
                }
                Err(e) => {
                    planting.refused = Some(e.to_string());
                    continue;
                }
            }
        }
        planting.dir = Some(way.dir);
    }
    if !made.is_empty() || !prepared.is_empty() {
        let extra: Vec<Place> = intent.iter().chain(&made).chain(&prepared).cloned().collect();
        match ledger.write(ws, dedup(recorded(&extra))) {
            Ok(wrote) => stats.manifests_written += usize::from(wrote),
            Err(e) => {
                log::warn!("cwd arming: recording {ws} failed: {e}");
                for planting in plantings.iter_mut().filter(|p| p.changes()) {
                    if let Some(dir) = &planting.dir {
                        discard(dir, planting.staged.as_ref());
                    }
                    planting.refused = Some(UNWRITABLE.to_string());
                }
                prepared.clear();
            }
        }
    }

    // 5. Publish.
    let mut present: Vec<Place> = Vec::new();
    let mut unconfirmed: Vec<Place> = Vec::new();
    for planting in &mut plantings {
        if planting.refused.is_some() {
            continue;
        }
        if matches!(planting.act, Act::Keep) {
            let key = slot(&planting.admitted.path).expect("a slot");
            // A failed setup promotes no record: what stood stays as it was.
            present.push(match (setup.is_ok(), place_at(&key)) {
                (false, Some(place)) => place.clone(),
                (_, place) => keep(place, cwd, plugin, &planting.admitted),
            });
            continue;
        }
        let Some(dir) = &planting.dir else { continue };
        match publish(dir, &roots, planting, cwd, plugin, &mut stats) {
            Published::Landed(place) => present.push(place),
            Published::Unconfirmed(place, reason) => {
                unconfirmed.push(place);
                planting.refused = Some(reason);
            }
            Published::Refused(reason) => planting.refused = Some(reason),
        }
    }
    for planting in &plantings {
        if let Some(reason) = &planting.refused {
            refusals[planting.admitted.index] = Some(reason.clone());
        }
    }

    // 6. Settle the record.
    let standing: HashMap<String, &Place> =
        present.iter().chain(&unconfirmed).filter_map(|p| Some((p.slot()?, p))).collect();
    let mut preserved: Vec<Place> = Vec::new();
    let mut replanted: Vec<Held> = Vec::new();
    let mut retiring: Vec<Held> = Vec::new();
    for place in here {
        let key = place.slot().unwrap_or_default();
        if let Some(now) = standing.get(&key) {
            if **now != place {
                replanted.push((ws.to_string(), place));
            }
        } else if declared.contains(&key) {
            preserved.push(place);
        } else {
            retiring.push((ws.to_string(), place));
        }
    }
    // Every reserved name goes with whatever a crash or a failed step left
    // at it; this pass's own new links and files' lines are owed no more
    // than what landed owes.
    let (reservations, intended): (Vec<Place>, Vec<Place>) =
        intent.into_iter().partition(|p| matches!(p.what, What::Temp { .. }));
    retiring.extend(leftovers.into_iter().chain(reservations).map(|p| (ws.to_string(), p)));
    let Outcome { released, mut retained } = retire(home, fence, retiring);
    // A folder made on the way stays while anything recorded lies inside:
    // this pass's plantings, what would not go, another workspace's.
    let holding: Vec<&Place> = present
        .iter()
        .chain(&unconfirmed)
        .chain(&preserved)
        .chain(retained.iter().map(|(_, p)| p))
        .chain(ledger.all().filter(|(id, _)| *id != ws).map(|(_, p)| p))
        .collect();
    let dirs_out = retire_dirs(fence, dirs.into_iter().chain(made).map(|p| (ws.to_string(), p)).collect(), &holding);
    retained.extend(dirs_out.retained);

    // What no line needs any more: what went, what was replaced, what was
    // forgotten, older owed lines, what this pass meant to plant but did not,
    // and every workspace's record of a link that gave way.
    let mut gone: Vec<Held> = released;
    gone.extend(replanted);
    gone.extend(dirs_out.released);
    gone.extend(forgotten);
    gone.extend(owed.into_iter().map(|p| (ws.to_string(), p)));
    gone.extend(
        intended
            .into_iter()
            .filter(|p| p.slot().and_then(|key| standing.get(&key)).is_none_or(|now| **now != *p))
            .map(|p| (ws.to_string(), p)),
    );
    let mut peers: Vec<(String, Vec<Place>)> = Vec::new();
    for (id, places) in ledger.places.iter().filter(|(id, _)| id != ws) {
        let (theirs, rest): (Vec<Place>, Vec<Place>) = places.iter().cloned().partition(|p| {
            p.plugin == plugin && matches!(p.what, What::Symlink { .. }) && cleared.iter().any(|at| p.at(cwd, at))
        });
        if !theirs.is_empty() {
            gone.extend(theirs.into_iter().map(|p| (id.clone(), p)));
            peers.push((id.clone(), rest));
        }
    }
    let mut kept: Vec<Place> = elsewhere;
    kept.extend(present);
    kept.extend(unconfirmed);
    kept.extend(preserved);
    kept.extend(retained.into_iter().map(|(_, p)| p));
    let others: Vec<Place> = ledger
        .places
        .iter()
        .filter(|(id, _)| id != ws)
        .flat_map(|(id, places)| {
            let rest = peers.iter().find(|(peer, _)| peer == id).map(|(_, rest)| rest.clone());
            rest.unwrap_or_else(|| places.clone())
        })
        .collect();
    // Behind the fence no line goes: a record that will not read could be
    // its claim, and a setup that failed may not have put in what replaces it.
    let still: Vec<Held> = if fence {
        let remaining: Vec<&Place> = kept.iter().chain(&others).collect();
        lines.release(gone, &remaining)
    } else {
        gone.into_iter().filter_map(|(id, p)| lines.line_left(p).map(|p| (id, p))).collect()
    };
    let mut still_peers: HashMap<String, Vec<Place>> = HashMap::new();
    for (id, place) in still {
        if id == ws {
            kept.push(place);
        } else {
            still_peers.entry(id).or_default().push(place);
        }
    }
    for (id, mut places) in peers {
        places.extend(still_peers.remove(&id).unwrap_or_default());
        match ledger.write(&id, dedup(places)) {
            Ok(wrote) => stats.manifests_written += usize::from(wrote),
            Err(e) => log::warn!("cwd arming: recording {id} failed: {e}"),
        }
    }
    match ledger.write(ws, dedup(kept)) {
        Ok(wrote) => stats.manifests_written += usize::from(wrote),
        Err(e) => log::warn!("cwd arming: recording {ws} failed: {e}"),
    }
    stats.excludes_written = lines.written;

    let mut report = CwdArmReport::default();
    for (arm, refusal) in arms.iter().zip(refusals) {
        let path = arm.path().to_string();
        match refusal {
            None => report.armed.push(path),
            Some(reason) => report.refused.push(ArmRefusal { path, reason }),
        }
    }
    for arm in past {
        let reason = format!("past the {} entries KeepDeck plants in one folder", CAPS.entries_max);
        report.refused.push(ArmRefusal { path: arm.path().to_string(), reason });
    }
    (report, stats)
}

/// The declarations that may be planted at all, each judged alone and against
/// the whole set; the rest get their refusal.
fn admit(
    arms: &[CwdArm],
    theirs: &HashSet<String>,
    allowed: &[PathBuf],
    roots: &Roots,
    refusals: &mut [Option<String>],
) -> Vec<Admitted> {
    let slots: Vec<Option<String>> = arms.iter().map(|arm| slot(arm.path())).collect();
    // Which declaration holds which: each path's ancestors looked up once.
    let mut first: HashMap<&str, usize> = HashMap::new();
    for (index, key) in slots.iter().enumerate() {
        if let Some(key) = key {
            first.entry(key.as_str()).or_insert(index);
        }
    }
    let mut inside: Vec<Option<usize>> = vec![None; arms.len()];
    let mut holds: Vec<Option<usize>> = vec![None; arms.len()];
    for (index, key) in slots.iter().enumerate() {
        let Some(key) = key else { continue };
        let ancestors = key.match_indices('/').map(|(at, _)| &key[..at]);
        if let Some(outer) = ancestors.filter_map(|ancestor| first.get(ancestor)).next() {
            inside[index] = Some(*outer);
            holds[*outer].get_or_insert(index);
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut admitted = Vec::new();
    for (index, arm) in arms.iter().enumerate() {
        let path = arm.path();
        let refusal = (|| {
            let (Some(parts), Some(key)) = (relative_parts(path), &slots[index]) else {
                return Err(format!("{path} is not a path inside this directory"));
            };
            if !crate::worktree_arm::hideable(path) {
                return Err(format!("{path} has a name git cannot be told to ignore"));
            }
            let oversized = path.len() > CAPS.path_max_bytes
                || match arm {
                    CwdArm::File { content, .. } => content.len() > CAPS.content_max_bytes,
                    CwdArm::Symlink { target, .. } => target.len() > CAPS.target_max_bytes,
                };
            if oversized {
                return Err(format!("{path} is larger than KeepDeck plants"));
            }
            if !seen.insert(key) {
                return Err(format!("{path} is declared twice"));
            }
            if let Some(outer) = inside[index] {
                return Err(format!("{path} lies inside {}, declared too", arms[outer].path()));
            }
            if let Some(inner) = holds[index] {
                return Err(format!("{path} holds {}, declared too", arms[inner].path()));
            }
            if theirs.contains(key) {
                return Err(format!("{path} is planted here by another agent"));
            }
            let want = match arm {
                CwdArm::Symlink { target, .. } => Want::Link(
                    link_target(target, allowed, roots)
                        .ok_or_else(|| format!("{path} would point outside what this agent may link to"))?,
                ),
                CwdArm::File { content, .. } => {
                    Want::File { bytes: content.as_bytes().to_vec(), digest: proof::digest(content.as_bytes()) }
                }
            };
            Ok(Admitted { index, path: parts.join("/"), parts, want })
        })();
        match refusal {
            Ok(one) => admitted.push(one),
            Err(reason) => refusals[index] = Some(reason),
        }
    }
    admitted
}

/// Where a link may point: an absolute path without `..` that exists, whose
/// real location sits inside one of `allowed` — returned as that real
/// location, which is what the link is made to — and which the proof will
/// recognize as ours once it is planted.
fn link_target(target: &str, allowed: &[PathBuf], roots: &Roots) -> Option<PathBuf> {
    let path = Path::new(target);
    if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    (allowed.iter().any(|dir| real.starts_with(dir)) && roots.hold(&real)).then_some(real)
}

/// What to do with one admitted declaration, read from the disk now.
#[allow(clippy::too_many_arguments)]
fn decide(
    cwd_fd: &File,
    home: &Path,
    roots: &Roots,
    ledger: &Ledger,
    plugin: &str,
    cwd: &str,
    whole: bool,
    admitted: &Admitted,
    place: Option<&Place>,
    stats: &mut Stats,
) -> Result<Act, String> {
    let path = &admitted.path;
    let locked = || format!("{path} cannot change while another workspace's record will not read");
    let way = disk::reach(cwd_fd, &admitted.parts, false).map_err(|e| e.to_string())?;
    let dir = match way {
        Reach::Missing => return Ok(Act::Create { clear: None }),
        Reach::Blocked { at, link: Some(link) } => {
            // The one link on the way that may give way: older builds' link to
            // codex's whole skills folder, into this home's staging — and no
            // other agent's place there.
            let theirs = ledger.all().any(|(_, p)| p.at(cwd, &at) && p.plugin != plugin);
            if proof::historical_folder_link(home, plugin, &at, &link) && !theirs {
                if !whole {
                    return Err(locked());
                }
                return Ok(Act::Create { clear: Some((at, link)) });
            }
            return Err(format!("{at} here is not a directory"));
        }
        Reach::Blocked { at, link: None } => return Err(format!("{at} here is not a directory")),
        Reach::Reached(way) => way.dir,
    };
    let leaf = OsStr::new(admitted.parts.last().expect("a declared path has a name"));
    let slot = observe(&dir, leaf, stats).map_err(|e| e.to_string())?;
    let landed = place.and_then(active);
    let ours = match &slot {
        Slot::Absent => return Ok(Act::Create { clear: None }),
        Slot::Link(text) => {
            if let Want::Link(target) = &admitted.want {
                if text == target {
                    return Ok(Act::Keep);
                }
            }
            roots.hold(text)
        }
        Slot::File { identity, digest } => match (place.map(|p| &p.what), &landed) {
            (_, Some(landed)) if proof::is_landed(landed, *identity, digest.as_deref()) => {
                if let Want::File { digest: want, .. } = &admitted.want {
                    if *want == landed.digest {
                        return Ok(Act::Keep);
                    }
                }
                true
            }
            (Some(What::File { receipt: None }), _) => {
                return Err(format!(
                    "{path} is named by an older KeepDeck record that cannot be verified — nothing was planted; \
                     move it aside to let KeepDeck manage it"
                ));
            }
            _ => false,
        },
        Slot::Other => false,
    };
    if !ours {
        return Err(format!("{path} is your own — nothing was planted"));
    }
    if !whole {
        return Err(locked());
    }
    Ok(Act::Replace { ours: slot, previous: landed })
}

/// Observe one name, counting what it costs.
fn observe(dir: &File, name: &OsStr, stats: &mut Stats) -> io::Result<Slot> {
    let slot = disk::observe(dir, name, CAPS.content_max_bytes as u64)?;
    stats.observed += 1;
    if matches!(slot, Slot::File { digest: Some(_), .. }) {
        stats.digested += 1;
    }
    Ok(slot)
}

/// The file a place's receipt says stands there, once landed.
fn active(place: &Place) -> Option<Landed> {
    match &place.what {
        What::File { receipt: Some(r) } if r.state == Landing::Active => {
            Some(Landed { identity: r.identity, digest: r.digest.clone() })
        }
        _ => None,
    }
}

/// What [`settle`] makes of a place.
pub(super) enum Settled {
    Place(Place),
    /// What stands there is not provably ours: the place is let go, and what
    /// stands there is left as it is.
    Forget(Place),
}

/// Settle a place a crash left mid-change, from what stands — reading only:
/// a prepared file is active once its slot holds exactly the staged file,
/// back to the file it was replacing when that one stands, and forgotten
/// otherwise. (A leftover temporary goes with its reserved name.) An error
/// reading any of it is an error: the place stays as it was, for a later
/// pass.
pub(super) fn settle(cwd_fd: &File, place: Place) -> io::Result<Settled> {
    let What::File { receipt: Some(receipt) } = &place.what else { return Ok(Settled::Place(place)) };
    if receipt.state == Landing::Active {
        return Ok(Settled::Place(place));
    }
    let Some(parts) = relative_parts(&place.path) else { return Ok(Settled::Forget(place)) };
    let dir = match disk::reach(cwd_fd, &parts, false)? {
        Reach::Reached(way) => way.dir,
        Reach::Missing | Reach::Blocked { .. } => return Ok(Settled::Forget(place)),
    };
    let leaf = OsStr::new(parts.last().expect("a place has a name"));
    let Slot::File { identity, digest } = disk::observe(&dir, leaf, CAPS.content_max_bytes as u64)? else {
        return Ok(Settled::Forget(place));
    };
    let staged = Landed { identity: receipt.identity, digest: receipt.digest.clone() };
    let landed = if proof::is_landed(&staged, identity, digest.as_deref()) {
        Some(staged)
    } else {
        receipt.previous.as_deref().filter(|p| proof::is_landed(p, identity, digest.as_deref())).cloned()
    };
    Ok(match landed {
        Some(landed) => Settled::Place(Place { what: What::File { receipt: Some(active_receipt(landed)) }, ..place }),
        None => Settled::Forget(place),
    })
}

fn active_receipt(landed: Landed) -> Receipt {
    Receipt { state: Landing::Active, identity: landed.identity, digest: landed.digest, previous: None }
}

/// The place a declaration that already stands as declared keeps: its own
/// record, exact from now on, while it records the kind that stands — a fresh
/// one when what stands now is of another kind than the record says.
fn keep(place: Option<&Place>, cwd: &str, plugin: &str, admitted: &Admitted) -> Place {
    match (place, &admitted.want) {
        (Some(place), Want::Link(_)) if matches!(place.what, What::Symlink { .. }) => {
            Place { hidden: Hidden::Exact, path: admitted.path.clone(), ..place.clone() }
        }
        (Some(place), Want::File { .. }) if matches!(place.what, What::File { receipt: Some(_) }) => {
            Place { hidden: Hidden::Exact, path: admitted.path.clone(), ..place.clone() }
        }
        _ => exact(cwd, plugin, admitted),
    }
}

/// A fresh exact place for a declaration.
fn exact(cwd: &str, plugin: &str, admitted: &Admitted) -> Place {
    let what = match &admitted.want {
        Want::Link(_) => What::Symlink { target: None },
        Want::File { .. } => What::File { receipt: None },
    };
    place(cwd, plugin, admitted.path.clone(), what)
}

fn place(cwd: &str, plugin: &str, path: String, what: What) -> Place {
    Place { cwd: cwd.to_string(), plugin: plugin.to_string(), path, what, hidden: Hidden::Exact }
}

/// Remove the link at `at` when it still points exactly at `link`.
fn clear_link(cwd_fd: &File, at: &str, link: &Path) -> io::Result<()> {
    let parts = relative_parts(at).ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "not a relative path"))?;
    let Reach::Reached(way) = disk::reach(cwd_fd, &parts, false)? else {
        return Err(io::Error::other("the way to it changed"));
    };
    let leaf = OsStr::new(parts.last().expect("a path has a name"));
    if fsb::read_link_at(&way.dir, leaf)? != link.as_os_str() {
        return Err(io::Error::other("it changed"));
    }
    fsb::remove_at(&way.dir, leaf, false)
}

/// How a publish ended.
enum Published {
    /// In place, as planted.
    Landed(Place),
    /// Renamed into place but not seen there as staged: its prepared record
    /// stays, for the next pass to settle from what stands.
    Unconfirmed(Place, String),
    Refused(String),
}

/// Publish one planting into its reached folder.
fn publish(dir: &File, roots: &Roots, planting: &Planting, cwd: &str, plugin: &str, stats: &mut Stats) -> Published {
    let admitted = &planting.admitted;
    let path = &admitted.path;
    let leaf = planting.leaf();
    let staged = planting.staged.as_ref();
    let late = || format!("{path} was taken while it was being planted — nothing was planted");
    // Over something of ours: only while it is still that.
    if let Act::Replace { ours, .. } = &planting.act {
        let still = match (ours, observe(dir, leaf, stats)) {
            (Slot::Link(_), Ok(Slot::Link(text))) => roots.hold(&text),
            (Slot::File { .. }, Ok(now)) => now == *ours,
            _ => false,
        };
        if !still {
            discard(dir, staged);
            return Published::Refused(late());
        }
    }
    let publish = if matches!(planting.act, Act::Replace { .. }) { Publish::Replace } else { Publish::Exclusive };
    match (&admitted.want, staged) {
        (Want::Link(target), _) => match fsb::link_at(target.as_os_str(), dir, leaf, through(planting, publish)) {
            Ok(()) => Published::Landed(place(cwd, plugin, path.clone(), What::Symlink { target: None })),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Published::Refused(late()),
            Err(e) => Published::Refused(e.to_string()),
        },
        (Want::File { digest, .. }, Some(file)) => {
            if let Err(e) = fsb::publish_at(dir, &file.name, leaf, publish) {
                discard(dir, Some(file));
                return Published::Refused(if e.kind() == ErrorKind::AlreadyExists { late() } else { e.to_string() });
            }
            let identity = file.identity.expect("only a file with an identity is staged for publishing");
            let landed = Landed { identity, digest: digest.clone() };
            let seen = match observe(dir, leaf, stats) {
                Ok(Slot::File { identity, digest }) => proof::is_landed(&landed, identity, digest.as_deref()),
                _ => false,
            };
            if seen {
                Published::Landed(place(cwd, plugin, path.clone(), What::File { receipt: Some(active_receipt(landed)) }))
            } else {
                let previous = if let Act::Replace { previous, .. } = &planting.act { previous.clone() } else { None };
                let receipt =
                    Receipt { state: Landing::Prepared, identity, digest: digest.clone(), previous: previous.map(Box::new) };
                let prepared = place(cwd, plugin, path.clone(), What::File { receipt: Some(receipt) });
                Published::Unconfirmed(prepared, format!("{path} could not be seen in place after it was planted"))
            }
        }
        (Want::File { .. }, None) => unreachable!("a file to publish is always staged"),
    }
}

/// The reserved name a link replacing one of ours is made as, first.
fn through(planting: &Planting, publish: Publish) -> Option<&OsStr> {
    match publish {
        Publish::Replace => Some(planting.temp.as_deref().expect("a replacement has its temporary named")),
        Publish::Exclusive => None,
    }
}

fn discard(dir: &File, staged: Option<&fsb::Staged>) {
    if let Some(file) = staged {
        let _ = fsb::remove_at(dir, &file.name, false);
    }
}

/// What a retirement did: the places that went or were forgotten, whose lines
/// may go, and those that must stay recorded.
pub(super) struct Outcome {
    pub released: Vec<Held>,
    pub retained: Vec<Held>,
}

/// Take back each of `gone` — every place judged by its own workspace's
/// roots and receipts — and answer what went or was forgotten and what must
/// stay recorded: a change that would not complete, or none at all while a
/// record will not read.
pub(super) fn retire(home: &Path, whole: bool, gone: Vec<Held>) -> Outcome {
    if !whole {
        return Outcome { released: Vec::new(), retained: gone };
    }
    let mut released = Vec::new();
    let mut retained = Vec::new();
    for (ws, place) in gone {
        match take_back(home, &ws, &place) {
            Ok(()) => released.push((ws, place)),
            Err(e) => {
                log::warn!("cwd arming: taking back {}/{} failed: {e}", place.cwd, place.path);
                retained.push((ws, place));
            }
        }
    }
    Outcome { released, retained }
}

/// Take one place's planting back when what stands there is provably ours;
/// anything else is left where it is, and the place is forgotten. A directory
/// that is gone takes its plantings with it; one that will not open is an
/// error, so the place stays recorded.
fn take_back(home: &Path, ws: &str, place: &Place) -> io::Result<()> {
    if matches!(place.what, What::Line { .. }) {
        return Ok(());
    }
    let Some((_, cwd_fd)) = open_cwd(&place.cwd)? else { return Ok(()) };
    let Settled::Place(place) = settle(&cwd_fd, place.clone())? else { return Ok(()) };
    let Some(parts) = relative_parts(&place.path) else { return Ok(()) };
    let dir = match disk::reach(&cwd_fd, &parts, false)? {
        Reach::Reached(way) => way.dir,
        // Not where we planted it any more: nothing is taken through that.
        Reach::Missing | Reach::Blocked { .. } => return Ok(()),
    };
    let leaf = OsStr::new(parts.last().expect("a place has a name"));
    let ours = match (&place.what, disk::observe(&dir, leaf, CAPS.content_max_bytes as u64)?) {
        (What::Symlink { .. }, Slot::Link(text)) => Roots::of(home, &place.plugin, ws).hold(&text),
        (What::File { .. }, Slot::File { identity, digest }) => {
            active(&place).is_some_and(|landed| proof::is_landed(&landed, identity, digest.as_deref()))
        }
        // A reserved name holds only the temporary it was reserved for.
        (What::Temp { .. }, Slot::File { .. } | Slot::Link(_)) => true,
        _ => false,
    };
    if ours {
        fsb::remove_at(&dir, leaf, false)?;
    }
    Ok(())
}

/// Take back the folders KeepDeck made on the way, deepest first, once none
/// of `holding` lies inside: each goes when it is still exactly the one made
/// and empty; one holding anything else now is forgotten.
pub(super) fn retire_dirs(whole: bool, dirs: Vec<Held>, holding: &[&Place]) -> Outcome {
    // Every folder something recorded lies in — an owed line lies nowhere.
    let mut around: HashSet<(&str, String)> = HashSet::new();
    for place in holding.iter().filter(|p| !matches!(p.what, What::Line { .. })) {
        let Some(key) = place.slot() else { continue };
        around.extend(key.match_indices('/').map(|(at, _)| (place.cwd.as_str(), key[..at].to_string())));
    }
    let (mut free, mut held): (Vec<Held>, Vec<Held>) = dirs
        .into_iter()
        .partition(|(_, dir)| !dir.slot().is_some_and(|key| around.contains(&(dir.cwd.as_str(), key))));
    if !whole {
        held.append(&mut free);
        return Outcome { released: Vec::new(), retained: held };
    }
    free.sort_by_key(|(_, dir)| std::cmp::Reverse(dir.path.matches('/').count()));
    let mut released = Vec::new();
    for (ws, dir) in free {
        let What::Dir { identity } = &dir.what else { continue };
        let removed = (|| -> io::Result<()> {
            let Some((_, cwd_fd)) = open_cwd(&dir.cwd)? else { return Ok(()) };
            let Some(parts) = relative_parts(&dir.path) else { return Ok(()) };
            let Reach::Reached(way) = disk::reach(&cwd_fd, &parts, false)? else { return Ok(()) };
            disk::remove_made_dir(&way.dir, OsStr::new(parts.last().expect("a place has a name")), *identity)?;
            Ok(())
        })();
        match removed {
            Ok(()) => released.push((ws, dir)),
            Err(e) => {
                log::warn!("cwd arming: taking back {}/{} failed: {e}", dir.cwd, dir.path);
                held.push((ws, dir));
            }
        }
    }
    Outcome { released, retained: held }
}

/// Take back older builds' whole-folder link for codex in `cwd`, when it is
/// exactly that and no record names its place; see
/// [`super::retire_historical_link`].
pub(super) fn retire_historical_link(home: &Path, ledger: &Ledger, cwd: &str) -> io::Result<()> {
    let Some((cwd, cwd_fd)) = open_cwd(cwd)? else { return Ok(()) };
    let at = proof::HISTORICAL_FOLDER_LINK;
    if ledger.all().any(|(_, p)| p.at(&cwd, at)) {
        return Ok(());
    }
    let parts = relative_parts(at).expect("a relative path");
    let Reach::Reached(way) = disk::reach(&cwd_fd, &parts, false)? else { return Ok(()) };
    let leaf = OsStr::new(parts.last().expect("a path has a name"));
    match disk::observe(&way.dir, leaf, 0)? {
        Slot::Link(text) if proof::historical_folder_link(home, proof::HISTORICAL_PLUGIN, at, &text) => {
            fsb::remove_at(&way.dir, leaf, false)
        }
        _ => Ok(()),
    }
}

/// The directory's real path and an open handle on it — None once it is
/// gone; any other failure to reach it is an error.
fn open_cwd(cwd: &str) -> io::Result<Option<(String, File)>> {
    let real = match std::fs::canonicalize(cwd) {
        Ok(real) => real,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    match fsb::open_dir(&real) {
        Ok(handle) => Ok(Some((canonical(&real.to_string_lossy()), handle))),
        Err(e) if e.kind() == ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Move the places matching `pick` out of `places`.
fn take(places: &mut Vec<Place>, pick: impl Fn(&Place) -> bool) -> Vec<Place> {
    let (taken, kept): (Vec<Place>, Vec<Place>) = std::mem::take(places).into_iter().partition(|p| pick(p));
    *places = kept;
    taken
}

/// One place per slot, kind and way of hiding, the last word kept.
fn dedup(places: Vec<Place>) -> Vec<Place> {
    let mut seen: HashSet<(String, String, String, std::mem::Discriminant<What>, Hidden)> = HashSet::new();
    let mut kept: Vec<Place> = Vec::new();
    for place in places.into_iter().rev() {
        let key = (
            place.cwd.clone(),
            place.plugin.clone(),
            place.slot().unwrap_or_default(),
            std::mem::discriminant(&place.what),
            place.hidden,
        );
        if seen.insert(key) {
            kept.push(place);
        }
    }
    kept.reverse();
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_beneath::Identity;

    fn receipt(state: Landing) -> Place {
        let identity = Identity { dev: 1, ino: 2, born: (3, 4) };
        let receipt = Receipt { state, identity, digest: "sha256:0".into(), previous: None };
        place("/r", "p", ".k/f".into(), What::File { receipt: Some(receipt) })
    }

    #[test]
    fn only_a_file_seen_in_place_counts_as_landed() {
        assert!(active(&receipt(Landing::Active)).is_some());
        assert!(active(&receipt(Landing::Prepared)).is_none(), "prepared proves nothing");
    }

    #[test]
    fn a_name_taken_while_it_was_being_planted_is_never_written_over() {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        let roots = Roots::of(&base.join("home"), "p", "ws-1");
        let dir = fsb::open_dir(&base).unwrap();
        let cwd = base.to_string_lossy().into_owned();
        let mut stats = Stats::default();
        // Decided as empty, then someone else's file and link arrived.
        std::fs::write(base.join("f"), "theirs").unwrap();
        std::os::unix::fs::symlink("/theirs", base.join("l")).unwrap();
        let bytes = b"ours".to_vec();
        let temp = fsb::temporary_beside(OsStr::new("f"));
        let staged = fsb::stage_at(&dir, &temp, b"ours", PLANTED_FILE_MODE).unwrap();
        let file = Planting {
            admitted: Admitted {
                index: 0,
                path: "f".into(),
                parts: vec!["f".into()],
                want: Want::File { digest: proof::digest(&bytes), bytes },
            },
            act: Act::Create { clear: None },
            temp: Some(temp),
            dir: None,
            staged: Some(staged),
            refused: None,
        };
        let Published::Refused(reason) = publish(&dir, &roots, &file, &cwd, "p", &mut stats) else { panic!() };
        assert_eq!(reason, "f was taken while it was being planted — nothing was planted");
        assert_eq!(std::fs::read_to_string(base.join("f")).unwrap(), "theirs");
        let link = Planting {
            admitted: Admitted { index: 1, path: "l".into(), parts: vec!["l".into()], want: Want::Link(base.join("x")) },
            act: Act::Create { clear: None },
            temp: None,
            dir: None,
            staged: None,
            refused: None,
        };
        let Published::Refused(reason) = publish(&dir, &roots, &link, &cwd, "p", &mut stats) else { panic!() };
        assert_eq!(reason, "l was taken while it was being planted — nothing was planted");
        assert_eq!(std::fs::read_link(base.join("l")).unwrap(), Path::new("/theirs"));
        let left = fsb::names_in(&dir, usize::MAX).unwrap().unwrap();
        assert_eq!(left.len(), 2, "the staged temporary went too: {left:?}");
    }
}
