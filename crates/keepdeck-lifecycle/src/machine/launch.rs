//! Launches: permits, admission and the sessions the sessions machine reports.
//!
//! A permit names one owner and one target. Admission is one step of the
//! machine just before the spawn: it spends the permit into an attempt, so
//! one permit never starts two processes. A permit expires by its timer's
//! revocation in the queue, not by the clock: an admission handled before the
//! revocation stands, and the attempt it makes is under the start boundary
//! and under Close like any other.

use super::{capture, Effect, Event, Fx, State, Timer, PERMIT_LIFE};
use crate::dir::Dir;
use crate::ids::{AskId, AttemptId, OpId, PaneId, PermitId, SessionId, WorkspaceId};
use crate::model::{Answer, Refusal};
use keepdeck_fsm::Owed;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Who a launch is for.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum LaunchOwner {
    Pane { pane: PaneId },
    /// A plugin's own process, through the SDK: no pane.
    Plugin { plugin: String, workspace: WorkspaceId },
    /// A pane on a remote endpoint: no folder of ours.
    Remote { pane: PaneId },
}

/// Who owns a session, as the sessions machine records it.
pub type SessionOwner = LaunchOwner;

impl LaunchOwner {
    pub fn pane(&self) -> Option<PaneId> {
        match self {
            LaunchOwner::Pane { pane } | LaunchOwner::Remote { pane } => Some(*pane),
            LaunchOwner::Plugin { .. } => None,
        }
    }
}

/// A lease asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum LeaseAsk {
    /// Permission to launch `owner` in `dir` (none for a remote pane).
    Launch { workspace: WorkspaceId, owner: LaunchOwner, dir: Option<Dir> },
    /// Permission to plant into `dir`, a folder a Close might delete.
    Arm { workspace: WorkspaceId, dir: Dir },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permit {
    pub workspace: WorkspaceId,
    /// None: a planting lease.
    pub owner: Option<LaunchOwner>,
    pub dir: Option<Dir>,
}

/// An admitted launch, until its session shows up or the door says it did
/// not start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub workspace: WorkspaceId,
    pub owner: LaunchOwner,
    pub dir: Option<Dir>,
    /// The Close that took it over at the start boundary.
    pub by: Option<OpId>,
}

/// A session of this launch, as the sessions machine reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub owner: SessionOwner,
    pub workspace: Option<WorkspaceId>,
    pub dir: Option<Dir>,
    pub attempt: Option<AttemptId>,
    pub ended: bool,
}

fn refused(fx: &mut Fx, ask: AskId, refusal: Refusal) {
    fx.answer(ask, Answer::refused(refusal));
}

/// Why a launch or a planting may not go to this target now, if it may not.
fn blocked(state: &State, workspace: &WorkspaceId, owner: Option<&LaunchOwner>, dir: Option<&Dir>) -> Option<Refusal> {
    if !state.open() {
        return Some(Refusal::BarrierUp);
    }
    if owner.is_some() && state.sessions_down {
        return Some(Refusal::SessionsDown);
    }
    let Some(ws) = state.world.workspaces.get(workspace) else { return Some(Refusal::NotFound) };
    if ws.archived || capture::archiving(state, workspace) {
        return Some(Refusal::Archived);
    }
    if capture::workspace_leaving(state, workspace) || dir.is_some_and(|dir| capture::folder_leaving(state, dir)) {
        return Some(Refusal::TargetLeaving);
    }
    if let Some(pane) = owner.and_then(LaunchOwner::pane) {
        if state.forgotten.pane(&state.world, &pane) || capture::pane_taken(state, &pane) {
            return Some(Refusal::TargetLeaving);
        }
    }
    None
}

pub fn lease(state: &mut State, ask: AskId, lease: LeaseAsk, fx: &mut Fx) {
    let (workspace, owner, dir) = match lease {
        LeaseAsk::Launch { workspace, owner, dir } => (workspace, Some(owner), dir),
        LeaseAsk::Arm { workspace, dir } => (workspace, None, Some(dir)),
    };
    if let Some(refusal) = blocked(state, &workspace, owner.as_ref(), dir.as_ref()) {
        return refused(fx, ask, refusal);
    }
    // A pane has one session at a time: while its last one is still alive —
    // stopping, too — no second launch is let in. A restart with resume waits
    // for the old process to be gone, at most the stop's own bound.
    if let Some(pane) = owner.as_ref().and_then(LaunchOwner::pane) {
        let busy = state.sessions.values().any(|row| !row.ended && row.owner.pane() == Some(pane))
            || state.attempts.values().any(|attempt| attempt.owner.pane() == Some(pane));
        if busy {
            return refused(fx, ask, Refusal::Busy);
        }
    }
    let (n, next) = state.next.permit.next();
    state.next.permit = next;
    let permit = PermitId(n);
    state.permits.insert(permit, Permit { workspace, owner, dir });
    fx.answer(ask, Answer::Leased { permit });
}

pub fn admit(state: &mut State, ask: AskId, permit: PermitId, owner: LaunchOwner, dir: Option<Dir>, fx: &mut Fx) {
    let Some(given) = state.permits.get(&permit) else { return refused(fx, ask, Refusal::NotFound) };
    if given.owner.as_ref() != Some(&owner) || given.dir != dir {
        return refused(fx, ask, Refusal::NotFound);
    }
    let workspace = given.workspace.clone();
    if let Some(refusal) = blocked(state, &workspace, Some(&owner), dir.as_ref()) {
        return refused(fx, ask, refusal);
    }
    state.permits.remove(&permit);
    let (n, next) = state.next.attempt.next();
    state.next.attempt = next;
    let attempt = AttemptId(n);
    state.attempts.insert(attempt, Attempt { workspace, owner, dir, by: None });
    fx.answer(ask, Answer::Admitted { attempt });
}

pub fn appeared(state: &mut State, session: SessionId, attempt: Option<AttemptId>, owner: SessionOwner, dir: Option<Dir>) {
    let workspace = match &owner {
        LaunchOwner::Plugin { workspace, .. } => Some(workspace.clone()),
        LaunchOwner::Pane { pane } | LaunchOwner::Remote { pane } => state.world.panes.get(pane).map(|row| row.workspace.clone()),
    };
    if let Some(attempt) = attempt {
        state.attempts.remove(&attempt);
    }
    // The first thing seen of a session may already be its end: the row is
    // kept, so its appearance and its end both count.
    state.sessions.entry(session).or_insert(Session { owner, workspace, dir, attempt, ended: false });
}

/// What launches need while the machine is in this state: each permit's
/// revocation, and the stop of a live session whose target is forgotten
/// and that no teardown has taken — a late session after a Close.
pub fn work(state: &State, mut owed: Owed<Effect, Event>) -> Owed<Effect, Event> {
    for &permit in state.permits.keys() {
        owed = owed.after(PERMIT_LIFE, Event::Timer(Timer::Permit { permit }));
    }
    for (&session, row) in &state.sessions {
        if row.ended || capture::session_in_teardown(state, row) {
            continue;
        }
        let forgotten = match &row.owner {
            LaunchOwner::Pane { pane } | LaunchOwner::Remote { pane } => state.forgotten.pane(&state.world, pane),
            LaunchOwner::Plugin { workspace, .. } => state.forgotten.workspaces.contains(workspace),
        };
        if forgotten {
            owed = owed.run(Effect::Stop { session, quick: false });
        }
    }
    owed
}
