//! One lifecycle for every change the engine makes: what is decided, from the
//! ledger and the disk, before anything is touched; then the changes, in an
//! order where a crash at any point leaves nothing of the user's harmed and
//! nothing of ours unrecorded that a record could not later find.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use super::disk::{self, Reach, Slot};
use super::lines::Lines;
use super::proof::{self, Roots};
use super::registry::{canonical, Held, Hidden, Landed, Landing, Ledger, Place, Receipt, What};
use super::{relative_parts, ArmRefusal, CwdArm, CwdArmReport, CAPS};
use crate::fs_beneath::{self as fsb, Publish};

/// The mode a planted file is made with: what an editor would make it.
const PLANTED_FILE_MODE: u32 = 0o644;

const UNREADABLE: &str = "KeepDeck's record of what it planted here could not be read";
const UNWRITABLE: &str = "KeepDeck's record of what it plants here could not be written";

/// What one admitted declaration is to become.
enum Want {
    Link(PathBuf),
    File { bytes: Vec<u8>, digest: String },
}

struct Admitted {
    index: usize,
    path: String,
    parts: Vec<String>,
    want: Want,
}

/// What is done with one admitted declaration.
enum Act {
    /// Already exactly as declared.
    Keep,
    /// Into an empty slot, after a link of ours on the way gave way.
    Create { clear: Option<(String, PathBuf)> },
    /// Over what stands there, which is ours: a link (by where it points) or
    /// a file (as landed).
    Replace { ours: Slot, previous: Option<Landed> },
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
) -> CwdArmReport {
    let refuse_all = |reason: &str| CwdArmReport {
        armed: Vec::new(),
        refused: arms.iter().map(|arm| ArmRefusal { path: arm.path().to_string(), reason: reason.into() }).collect(),
    };
    let content: usize =
        arms.iter().map(|arm| if let CwdArm::File { content, .. } = arm { content.len() } else { 0 }).sum();
    if content > CAPS.total_content_max_bytes {
        return refuse_all("this agent declares more than KeepDeck plants in one folder");
    }
    let (arms, past) = arms.split_at(arms.len().min(CAPS.entries_max));
    let Some((cwd, cwd_fd)) = open_cwd(cwd) else { return refuse_all("this directory no longer exists") };
    let cwd = cwd.as_str();
    let mut ledger = match Ledger::read(root) {
        Ok(ledger) if !ledger.unreadable.iter().any(|id| id == ws) => ledger,
        Ok(_) => return refuse_all(UNREADABLE),
        Err(e) => {
            log::warn!("cwd arming: reading the records failed: {e}");
            return refuse_all(UNREADABLE);
        }
    };
    let whole = ledger.whole();
    let roots = Roots::of(home, plugin, ws);
    let allowed: Vec<PathBuf> = allowed.iter().filter_map(|dir| std::fs::canonicalize(dir).ok()).collect();

    let mut refusals: Vec<Option<String>> = vec![None; arms.len()];
    let admitted = admit(arms, cwd, plugin, &ledger, &allowed, &mut refusals);

    // This plugin's places here: those still declared, with what stands at
    // them recovered first; the rest retire.
    let mine = ledger.of(ws);
    let (here, elsewhere): (Vec<Place>, Vec<Place>) =
        mine.into_iter().partition(|p| p.cwd == cwd && p.plugin == plugin);
    let mut forgotten: Vec<Held> = Vec::new();
    let mut here: Vec<Place> = here
        .into_iter()
        .filter_map(|place| match settle(&cwd_fd, place) {
            Settled::Place(place) => Some(place),
            Settled::Forget(place) => {
                forgotten.push((ws.to_string(), place));
                None
            }
        })
        .collect();
    let dirs: Vec<Place> = take(&mut here, |p| matches!(p.what, What::Dir { .. }));

    // Decide.
    let mut acts: Vec<(Admitted, Act)> = Vec::new();
    for admitted in admitted {
        // An exact place over an older build's one for the same entry.
        let place = here.iter().filter(|p| p.at(cwd, &admitted.path)).max_by_key(|p| p.hidden == Hidden::Exact);
        match decide(&cwd_fd, home, &roots, &ledger, plugin, cwd, whole, &admitted, place) {
            Ok(act) => acts.push((admitted, act)),
            Err(reason) => refusals[admitted.index] = Some(reason),
        }
    }

    // Make the way, stage the files, and record all of it before anything is
    // published: a crash from here on leaves records for what may not stand,
    // never a planting no record names.
    let mut staged: Vec<(usize, File, Option<fsb::Staged>)> = Vec::new();
    let mut cleared: Vec<String> = Vec::new();
    let mut made: Vec<Place> = Vec::new();
    let mut prepared: Vec<Place> = Vec::new();
    for (i, (admitted, act)) in acts.iter().enumerate() {
        if matches!(act, Act::Keep) {
            continue;
        }
        if let Act::Create { clear: Some((at, link)), .. } = act {
            if let Err(e) = clear_link(&cwd_fd, at, link) {
                refusals[admitted.index] = Some(format!("{at} could not give way: {e}"));
                continue;
            }
            cleared.push(at.clone());
        }
        let way = match disk::reach(&cwd_fd, &admitted.parts, true) {
            Ok(Reach::Reached(way)) => way,
            Ok(Reach::Blocked { at, .. }) => {
                refusals[admitted.index] = Some(format!("{at} here is not a directory"));
                continue;
            }
            Ok(Reach::Missing) => unreachable!("a way that makes folders is never missing one"),
            Err(e) => {
                refusals[admitted.index] = Some(e.to_string());
                continue;
            }
        };
        made.extend(way.made.into_iter().map(|(path, identity)| place(cwd, plugin, path, What::Dir { identity })));
        let leaf = OsStr::new(admitted.parts.last().expect("a declared path has a name"));
        let file = match &admitted.want {
            Want::Link(_) => None,
            Want::File { bytes, digest } => match fsb::stage_at(&way.dir, leaf, bytes, PLANTED_FILE_MODE) {
                Ok(file) => {
                    let Some(identity) = file.identity else {
                        let _ = fsb::remove_at(&way.dir, &file.name, false);
                        refusals[admitted.index] =
                            Some(format!("{} cannot be told apart from a later file on this volume", admitted.path));
                        continue;
                    };
                    let previous = if let Act::Replace { previous, .. } = act { previous.clone() } else { None };
                    let receipt = Receipt {
                        state: Landing::Prepared,
                        identity,
                        digest: digest.clone(),
                        temp: Some(file.name.to_string_lossy().into_owned()),
                        previous: previous.map(Box::new),
                    };
                    prepared.push(place(cwd, plugin, admitted.path.clone(), What::File { receipt: Some(receipt) }));
                    Some(file)
                }
                Err(e) => {
                    refusals[admitted.index] = Some(e.to_string());
                    continue;
                }
            },
        };
        staged.push((i, way.dir, file));
    }
    let new_links = acts
        .iter()
        .enumerate()
        .filter(|(i, (a, _))| matches!(a.want, Want::Link(_)) && staged.iter().any(|(s, _, _)| s == i))
        .map(|(_, (a, _))| place(cwd, plugin, a.path.clone(), What::Symlink { target: None }));
    let recorded: Vec<Place> = elsewhere
        .iter()
        .chain(&here)
        .chain(&dirs)
        .chain(&made)
        .cloned()
        .chain(new_links)
        .chain(prepared.iter().cloned())
        .collect();
    let mut lines = Lines::default();
    let written = ledger.write(ws, dedup(recorded));
    // Every line what will stand needs, before any of it is published.
    let hidden = written.as_ref().map_err(|e| e.to_string()).and_then(|()| {
        let standing: Vec<Place> = acts.iter().map(|(a, _)| exact(cwd, plugin, a)).collect();
        lines.ensure(&standing).map_err(|e| e.to_string())
    });
    if let Err(e) = &hidden {
        log::warn!("cwd arming: preparing {ws} in {cwd} failed: {e}");
    }

    // Publish.
    let mut present: Vec<Place> = Vec::new();
    for (i, (admitted, act)) in acts.iter().enumerate() {
        let entry = staged.iter().find(|(s, _, _)| *s == i);
        let outcome = match (act, entry, &hidden) {
            (Act::Keep, _, _) => Ok(keep(here.iter().find(|p| p.at(cwd, &admitted.path)), cwd, plugin, admitted)),
            (_, None, _) => continue,
            (_, Some((_, dir, file)), Err(_)) => {
                discard(dir, file.as_ref());
                Err(written.as_ref().err().map_or("this could not be kept from git", |_| UNWRITABLE).to_string())
            }
            (_, Some((_, dir, file)), Ok(())) => publish(dir, &roots, admitted, act, file.as_ref(), cwd, plugin),
        };
        match outcome {
            Ok(place) => present.push(place),
            Err(reason) => refusals[admitted.index] = Some(reason),
        }
    }

    // Retire what is no longer here: places not declared, and those whose
    // declaration was refused this time.
    let retiring: Vec<Held> = here
        .into_iter()
        .filter(|p| !present.iter().any(|kept| kept.at(cwd, &p.path) && kept == p))
        .map(|p| (ws.to_string(), p))
        .collect();
    let replanted: Vec<Held> =
        retiring.iter().filter(|(_, p)| present.iter().any(|kept| kept.at(cwd, &p.path))).cloned().collect();
    let gone: Vec<Held> = retiring.into_iter().filter(|r| !replanted.contains(r)).collect();
    let Outcome { released, mut retained } = retire(home, whole, gone);
    let dirs_out = retire_dirs(whole, dirs.into_iter().chain(made).map(|p| (ws.to_string(), p)).collect(), &present);
    retained.extend(dirs_out.retained);
    let dirs_released = dirs_out.released;
    let mut kept: Vec<Place> = elsewhere;
    kept.extend(present);
    kept.extend(retained.iter().map(|(_, p)| p.clone()));
    let others: Vec<Place> = ledger.all().filter(|(id, _)| *id != ws).map(|(_, p)| p.clone()).collect();
    let remaining: Vec<&Place> = kept.iter().chain(&others).collect();
    let mut gone_lines: Vec<Held> = released;
    gone_lines.extend(replanted);
    gone_lines.extend(dirs_released);
    gone_lines.extend(forgotten);
    // A link that gave way is gone for every workspace that recorded it.
    let mut peers: Vec<(String, Vec<Place>)> = Vec::new();
    for (id, places) in ledger.places.iter().filter(|(id, _)| id != ws) {
        let (theirs, rest): (Vec<Place>, Vec<Place>) = places.iter().cloned().partition(|p| {
            p.plugin == plugin && matches!(p.what, What::Symlink { .. }) && cleared.iter().any(|at| p.at(cwd, at))
        });
        if !theirs.is_empty() {
            gone_lines.extend(theirs.into_iter().map(|p| (id.clone(), p)));
            peers.push((id.clone(), rest));
        }
    }
    let remaining: Vec<&Place> =
        remaining.into_iter().filter(|p| !gone_lines.iter().any(|(_, gone)| gone == *p)).collect();
    let still = if whole && !gone_lines.is_empty() { lines.release(&gone_lines, &remaining) } else { Vec::new() };
    for (id, mut places) in peers {
        places.extend(still.iter().filter(|(w, _)| *w == id).map(|(_, p)| p.clone()));
        if let Err(e) = ledger.write(&id, places) {
            log::warn!("cwd arming: recording {id} failed: {e}");
        }
    }
    kept.extend(still.into_iter().filter(|(w, _)| w == ws).map(|(_, p)| p));
    if let Err(e) = ledger.write(ws, dedup(kept)) {
        log::warn!("cwd arming: recording {ws} failed: {e}");
    }

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
    report
}

/// The declarations that may be planted at all, each judged alone and against
/// the whole set; the rest get their refusal.
fn admit(
    arms: &[CwdArm],
    cwd: &str,
    plugin: &str,
    ledger: &Ledger,
    allowed: &[PathBuf],
    refusals: &mut [Option<String>],
) -> Vec<Admitted> {
    let mut admitted = Vec::new();
    for (index, arm) in arms.iter().enumerate() {
        let path = arm.path();
        let refusal = (|| {
            let Some(parts) = relative_parts(path) else {
                return Err(format!("{path} is not a path inside this directory"));
            };
            let oversized = path.len() > CAPS.path_max_bytes
                || match arm {
                    CwdArm::File { content, .. } => content.len() > CAPS.content_max_bytes,
                    CwdArm::Symlink { target, .. } => target.len() > CAPS.target_max_bytes,
                };
            if oversized {
                return Err(format!("{path} is larger than KeepDeck plants"));
            }
            let twice = arms.iter().enumerate().any(|(other, arm)| {
                other != index && arm.path().to_lowercase() == path.to_lowercase() && other < index
            });
            if twice {
                return Err(format!("{path} is declared twice"));
            }
            if let Some(outer) = arms.iter().map(CwdArm::path).find(|other| nested(cwd, other, path)) {
                return Err(format!("{path} lies inside {outer}, declared too"));
            }
            if let Some(inner) = arms.iter().map(CwdArm::path).find(|other| nested(cwd, path, other)) {
                return Err(format!("{path} holds {inner}, declared too"));
            }
            if ledger.all().any(|(_, p)| p.at(cwd, path) && p.plugin != plugin) {
                return Err(format!("{path} is planted here by another agent"));
            }
            let want = match arm {
                CwdArm::Symlink { target, .. } => Want::Link(
                    link_target(target, allowed)
                        .ok_or_else(|| format!("{path} would point outside what this agent may link to"))?,
                ),
                CwdArm::File { content, .. } => {
                    Want::File { bytes: content.as_bytes().to_vec(), digest: proof::digest(content.as_bytes()) }
                }
            };
            Ok(Admitted { index, path: path.to_string(), parts, want })
        })();
        match refusal {
            Ok(one) => admitted.push(one),
            Err(reason) => refusals[index] = Some(reason),
        }
    }
    admitted
}

/// Whether `inner` lies inside `outer`, both entries of `cwd`.
fn nested(cwd: &str, outer: &str, inner: &str) -> bool {
    let (Some(o), Some(i)) = (relative_parts(outer), relative_parts(inner)) else { return false };
    i.len() > o.len() && super::registry::same_entry(Path::new(cwd), outer, &i[..o.len()].join("/"))
}

/// Where a link may point: an absolute path without `..` that exists, whose
/// real location sits inside one of `allowed` — returned as that real
/// location, which is what the link is made to.
fn link_target(target: &str, allowed: &[PathBuf]) -> Option<PathBuf> {
    let path = Path::new(target);
    if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    allowed.iter().any(|dir| real.starts_with(dir)).then_some(real)
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
            if proof::historical_folder_link(home, &at, &link) && !theirs {
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
    let slot = disk::observe(&dir, leaf, CAPS.content_max_bytes as u64).map_err(|e| e.to_string())?;
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

/// Settle a place a crash left mid-change: a prepared file is active once
/// its slot holds exactly the staged file, back to the file it was replacing
/// when that one stands, and forgotten otherwise. A leftover temporary goes
/// when it is still the staged file. A way that will not open keeps the place
/// as it was, for a later pass.
pub(super) fn settle(cwd_fd: &File, place: Place) -> Settled {
    let What::File { receipt: Some(receipt) } = &place.what else { return Settled::Place(place) };
    if receipt.state == Landing::Active {
        return Settled::Place(place);
    }
    let Some(parts) = relative_parts(&place.path) else { return Settled::Forget(place) };
    let dir = match disk::reach(cwd_fd, &parts, false) {
        Ok(Reach::Reached(way)) => way.dir,
        Ok(_) => return Settled::Forget(place),
        Err(_) => return Settled::Place(place),
    };
    if let Some(temp) = &receipt.temp {
        if fsb::identity_at(&dir, OsStr::new(temp)).ok().flatten() == Some(receipt.identity) {
            let _ = fsb::remove_at(&dir, OsStr::new(temp), false);
        }
    }
    let leaf = OsStr::new(parts.last().expect("a place has a name"));
    let Ok(slot) = disk::observe(&dir, leaf, CAPS.content_max_bytes as u64) else { return Settled::Place(place) };
    let Slot::File { identity, digest } = slot else { return Settled::Forget(place) };
    let staged = Landed { identity: receipt.identity, digest: receipt.digest.clone() };
    let landed = if proof::is_landed(&staged, identity, digest.as_deref()) {
        Some(staged)
    } else {
        receipt.previous.as_deref().filter(|p| proof::is_landed(p, identity, digest.as_deref())).cloned()
    };
    match landed {
        Some(landed) => Settled::Place(Place { what: What::File { receipt: Some(active_receipt(landed)) }, ..place }),
        None => Settled::Forget(place),
    }
}

fn active_receipt(landed: Landed) -> Receipt {
    Receipt { state: Landing::Active, identity: landed.identity, digest: landed.digest, temp: None, previous: None }
}

/// The place a declaration that already stands as declared keeps: its own,
/// exact from now on.
fn keep(place: Option<&Place>, cwd: &str, plugin: &str, admitted: &Admitted) -> Place {
    match place {
        Some(place) if !matches!(place.what, What::File { receipt: None }) => {
            Place { hidden: Hidden::Exact, ..place.clone() }
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

/// Publish one declaration into its reached folder, and answer its place —
/// a file's receipt active once it is seen in place as staged.
fn publish(
    dir: &File,
    roots: &Roots,
    admitted: &Admitted,
    act: &Act,
    staged: Option<&fsb::Staged>,
    cwd: &str,
    plugin: &str,
) -> Result<Place, String> {
    let path = &admitted.path;
    let leaf = OsStr::new(admitted.parts.last().expect("a declared path has a name"));
    let late = || format!("{path} was taken while it was being planted — nothing was planted");
    // Over something of ours: only while it is still that.
    if let Act::Replace { ours, .. } = act {
        let now = disk::observe(dir, leaf, CAPS.content_max_bytes as u64).map_err(|e| e.to_string())?;
        let still = match (ours, &now) {
            (Slot::Link(_), Slot::Link(text)) => roots.hold(text),
            (Slot::File { .. }, now) => now == ours,
            _ => false,
        };
        if !still {
            discard(dir, staged);
            return Err(late());
        }
    }
    let publish = if matches!(act, Act::Replace { .. }) { Publish::Replace } else { Publish::Exclusive };
    let what = match (&admitted.want, staged) {
        (Want::Link(target), _) => {
            fsb::link_at(target.as_os_str(), dir, leaf, publish).map_err(|e| match e.kind() {
                ErrorKind::AlreadyExists => late(),
                _ => e.to_string(),
            })?;
            What::Symlink { target: None }
        }
        (Want::File { digest, .. }, Some(file)) => {
            if let Err(e) = fsb::publish_at(dir, &file.name, leaf, publish) {
                discard(dir, Some(file));
                return Err(if e.kind() == ErrorKind::AlreadyExists { late() } else { e.to_string() });
            }
            let identity = file.identity.expect("only a file with an identity is staged for publishing");
            let staged = Landed { identity, digest: digest.clone() };
            let landed = match disk::observe(dir, leaf, CAPS.content_max_bytes as u64) {
                Ok(Slot::File { identity, digest }) => proof::is_landed(&staged, identity, digest.as_deref()),
                _ => false,
            };
            if !landed {
                // Published, but not seen as staged: it stays prepared, and the
                // next pass settles it from what stands then.
                return Err(format!("{path} could not be seen in place after it was planted"));
            }
            What::File { receipt: Some(active_receipt(staged)) }
        }
        (Want::File { .. }, None) => unreachable!("a file to publish is always staged"),
    };
    Ok(place(cwd, plugin, path.clone(), what))
}

fn discard(dir: &File, staged: Option<&fsb::Staged>) {
    if let Some(file) = staged {
        let _ = fsb::remove_at(dir, &file.name, false);
    }
}

/// Take back each of `gone` — every place judged by its own workspace's
/// roots and receipts — and answer what went or was forgotten (whose lines
/// may go) and what must stay recorded (a change that would not complete, or
/// none allowed while a record will not read).
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

/// What a retirement did: the places that went or were forgotten, whose lines
/// may go, and those that must stay recorded.
pub(super) struct Outcome {
    pub released: Vec<Held>,
    pub retained: Vec<Held>,
}

/// Take one place's planting back when what stands there is provably ours;
/// anything else is left where it is, and the place is forgotten.
fn take_back(home: &Path, ws: &str, place: &Place) -> io::Result<()> {
    let Some((_, cwd_fd)) = open_cwd(&place.cwd) else { return Ok(()) };
    let Settled::Place(place) = settle(&cwd_fd, place.clone()) else { return Ok(()) };
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
        _ => false,
    };
    if ours {
        fsb::remove_at(&dir, leaf, false)?;
    }
    Ok(())
}

/// Take back the folders KeepDeck made on the way, deepest first, once none
/// of `present` lies inside: each goes when it is still exactly the one made
/// and empty; one holding anything else now is forgotten.
pub(super) fn retire_dirs(whole: bool, dirs: Vec<Held>, present: &[Place]) -> Outcome {
    let (mut free, mut held): (Vec<Held>, Vec<Held>) = dirs
        .into_iter()
        .partition(|(_, dir)| !present.iter().any(|p| p.cwd == dir.cwd && nested(&p.cwd, &dir.path, &p.path)));
    if !whole {
        held.append(&mut free);
        return Outcome { released: Vec::new(), retained: held };
    }
    free.sort_by_key(|(_, dir)| std::cmp::Reverse(dir.path.matches('/').count()));
    let mut released = Vec::new();
    for (ws, dir) in free {
        let What::Dir { identity } = &dir.what else { continue };
        let removed = (|| -> io::Result<()> {
            let Some((_, cwd_fd)) = open_cwd(&dir.cwd) else { return Ok(()) };
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

/// The directory's real path and an open handle on it, while it is one.
fn open_cwd(cwd: &str) -> Option<(String, File)> {
    let real = std::fs::canonicalize(cwd).ok()?;
    let handle = fsb::open_dir(&real).ok()?;
    Some((canonical(&real.to_string_lossy()), handle))
}

/// Move the places matching `pick` out of `places`.
fn take(places: &mut Vec<Place>, pick: impl Fn(&Place) -> bool) -> Vec<Place> {
    let (taken, kept): (Vec<Place>, Vec<Place>) = std::mem::take(places).into_iter().partition(|p| pick(p));
    *places = kept;
    taken
}

/// One place per entry and kind, the last word kept.
fn dedup(places: Vec<Place>) -> Vec<Place> {
    let mut kept: Vec<Place> = Vec::new();
    for place in places.into_iter().rev() {
        let twin = kept.iter().any(|k| {
            k.at(&place.cwd, &place.path)
                && k.plugin == place.plugin
                && std::mem::discriminant(&k.what) == std::mem::discriminant(&place.what)
                && k.hidden == place.hidden
        });
        if !twin {
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
        let receipt = Receipt { state, identity, digest: "sha256:0".into(), temp: None, previous: None };
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
        // Decided as empty, then someone else's file and link arrived.
        std::fs::write(base.join("f"), "theirs").unwrap();
        std::os::unix::fs::symlink("/theirs", base.join("l")).unwrap();
        let bytes = b"ours".to_vec();
        let file = Admitted {
            index: 0,
            path: "f".into(),
            parts: vec!["f".into()],
            want: Want::File { digest: proof::digest(&bytes), bytes },
        };
        let staged = fsb::stage_at(&dir, OsStr::new("f"), b"ours", PLANTED_FILE_MODE).unwrap();
        let create = Act::Create { clear: None };
        let refused = publish(&dir, &roots, &file, &create, Some(&staged), &cwd, "p").unwrap_err();
        assert_eq!(refused, "f was taken while it was being planted — nothing was planted");
        assert_eq!(std::fs::read_to_string(base.join("f")).unwrap(), "theirs");
        let link = Admitted { index: 1, path: "l".into(), parts: vec!["l".into()], want: Want::Link(base.join("x")) };
        let refused = publish(&dir, &roots, &link, &create, None, &cwd, "p").unwrap_err();
        assert_eq!(refused, "l was taken while it was being planted — nothing was planted");
        assert_eq!(std::fs::read_link(base.join("l")).unwrap(), Path::new("/theirs"));
        let left = fsb::names_in(&dir, usize::MAX).unwrap().unwrap();
        assert_eq!(left.len(), 2, "the staged temporary went too: {left:?}");
    }
}
