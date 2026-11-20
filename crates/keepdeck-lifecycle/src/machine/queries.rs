//! What doors ask of the machine's state without changing it: the offer of a
//! Close or archive dialog, a place for a new team, who holds a folder.

use super::{capture, create, Kind, State};
use crate::dir::Dir;
use crate::ids::{OpId, PaneId, SessionId, TeamId, WorkspaceId};
use crate::model::{Consent, Folder, Intent, Place, Refusal};
use crate::places;
use crate::world::TeamAt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The whole offer of a Close or archive dialog. The dialog shows it and
/// freezes it as the consent; at the confirm the machine checks it again
/// under its capture — what is gone narrows it, a change of what the
/// operation is asks for a new preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub struct Preview {
    /// Refused now, and why.
    pub refusal: Option<Refusal>,
    /// The panes whose processes it stops.
    pub stops: Vec<PaneId>,
    /// The folders it may delete.
    pub folders: Vec<Folder>,
    /// Creations still out: what their tickets make is deleted too.
    pub creations: Vec<OpId>,
    /// An agent's close of the last member of its team: the team, which the
    /// dialog offers to disband instead — with its own offer.
    pub last_of: Option<(TeamId, Box<Preview>)>,
}

fn empty(refusal: Option<Refusal>) -> Preview {
    Preview { refusal, stops: Vec::new(), folders: Vec::new(), creations: Vec::new(), last_of: None }
}

/// The folders a teardown of `teams` may delete: each team's own folder,
/// never the workspace's root, and none another team that stays still works
/// in — and the creations still out, each with the folder its ticket makes.
fn deletable(state: &State, workspace: &WorkspaceId, teams: &[TeamId]) -> (Vec<Folder>, Vec<(OpId, Folder)>) {
    let Some(ws) = state.world.workspaces.get(workspace) else { return (Vec::new(), Vec::new()) };
    let leaving: BTreeSet<&TeamId> = teams.iter().collect();
    let mut folders = Vec::new();
    let mut creations = Vec::new();
    for team in teams {
        let Some(row) = state.world.teams.get(team) else { continue };
        let (path, branch) = match &row.at {
            TeamAt::Attached { cwd, branch } => (cwd.clone(), branch.clone()),
            TeamAt::Creating { op, ticket } => {
                creations.push((*op, Folder { repo: ticket.repo.clone(), path: ticket.path.clone(), branch: Some(ticket.branch.clone()) }));
                continue;
            }
            TeamAt::Failed { ticket } => (ticket.path.clone(), Some(ticket.branch.clone())),
            TeamAt::Unplaced => continue,
        };
        if path == ws.cwd || folders.iter().any(|folder: &Folder| folder.path == path) {
            continue;
        }
        let shared = state.world.teams.iter().any(|(other, row)| {
            !leaving.contains(other) && matches!(&row.at, TeamAt::Attached { cwd, .. } if *cwd == path)
        });
        if !shared {
            folders.push(Folder { repo: ws.cwd.clone(), path, branch });
        }
    }
    (folders, creations)
}

/// What a Close would end and may delete now: the facts its dialog shows,
/// and what its confirm is held to.
pub struct Offer {
    pub stops: Vec<PaneId>,
    pub folders: Vec<Folder>,
    /// Creations still out, each with the folder its ticket makes.
    pub creations: Vec<(OpId, Folder)>,
}

impl Offer {
    fn preview(self, refusal: Option<Refusal>) -> Preview {
        let creations = self.creations.into_iter().map(|(op, _)| op).collect();
        Preview { refusal, stops: self.stops, folders: self.folders, creations, last_of: None }
    }

    /// Whether a Close confirmed on `consent` would do more than its dialog
    /// showed: end an agent it did not show, or — when the person agreed to
    /// delete — offer a worktree or a creation it did not. What has gone
    /// since only narrows it.
    pub fn outgrows(&self, consent: &Consent) -> bool {
        let unseen_stop = self.stops.iter().any(|pane| !consent.stops.contains(pane));
        let deletes = !consent.folders.is_empty() || !consent.tickets.is_empty();
        let unseen_folder = self.folders.iter().any(|folder| !consent.folders.iter().any(|agreed| agreed.path == folder.path));
        let unseen_creation = self.creations.iter().any(|(op, _)| !consent.tickets.contains(op));
        unseen_stop || (deletes && (unseen_folder || unseen_creation))
    }

    /// The consent a confirmed Close is held to: what the person agreed to
    /// that is still on offer. A folder another team works in since is not
    /// the close's to delete — nor are that team's sessions in it its to
    /// stop. An agreed creation brings the folder its ticket makes, so the
    /// checkout goes once git is done with it.
    pub fn agreed(&self, consent: Consent) -> Consent {
        let offered = |path: &Dir| self.folders.iter().any(|folder| &folder.path == path);
        let mut folders: Vec<Folder> = consent.folders.into_iter().filter(|folder| offered(&folder.path)).collect();
        let tickets: Vec<OpId> = consent.tickets.into_iter().filter(|op| self.creations.iter().any(|(offered, _)| offered == op)).collect();
        for (op, folder) in &self.creations {
            if tickets.contains(op) && !folders.iter().any(|agreed| agreed.path == folder.path) {
                folders.push(folder.clone());
            }
        }
        Consent { stops: consent.stops, folders, tickets }
    }
}

/// An agent's own close ends its pane and deletes nothing: its team, and
/// the team's folder, stay.
pub fn close_agent_offer(pane: PaneId) -> Offer {
    Offer { stops: vec![pane], folders: Vec::new(), creations: Vec::new() }
}

/// The panes still landing in the workspace — on `team`, or on any team for
/// a whole-workspace close — that are not members yet. A Close begun now
/// waits for them and takes them.
fn landing(state: &State, workspace: &WorkspaceId, team: Option<&TeamId>) -> Vec<PaneId> {
    state
        .ops
        .values()
        .filter(|op| &op.workspace == workspace)
        .filter_map(|op| create::landing(op, state.saved))
        .filter(|(onto, _)| team.is_none_or(|team| onto == team))
        .map(|(_, pane)| pane)
        .collect()
}

fn with_landing(mut stops: Vec<PaneId>, landing: Vec<PaneId>) -> Vec<PaneId> {
    for pane in landing {
        if !stops.contains(&pane) {
            stops.push(pane);
        }
    }
    stops
}

pub fn disband_offer(state: &State, workspace: &WorkspaceId, team: &TeamId) -> Offer {
    let (folders, creations) = deletable(state, workspace, std::slice::from_ref(team));
    let stops = with_landing(state.world.members(team), landing(state, workspace, Some(team)));
    Offer { stops, folders, creations }
}

pub fn close_workspace_offer(state: &State, workspace: &WorkspaceId) -> Offer {
    let (folders, creations) = deletable(state, workspace, &state.world.teams_of(workspace));
    let stops = with_landing(state.world.panes_of(workspace), landing(state, workspace, None));
    Offer { stops, folders, creations }
}

pub fn preview(state: &State, intent: &Intent) -> Preview {
    if !state.open() {
        return empty(Some(Refusal::BarrierUp));
    }
    let workspace = intent.workspace();
    if !state.world.workspaces.contains_key(workspace) {
        return empty(Some(Refusal::NotFound));
    }
    match intent {
        // Each refusal is its intent's own rule, so the dialog never says
        // what the confirm would not.
        Intent::CloseAgent { pane, .. } => {
            let refusal = capture::close_agent_blocked(state, workspace, pane);
            if refusal == Some(Refusal::NotFound) {
                return empty(refusal);
            }
            let team = state.world.panes.get(pane).and_then(|row| row.team.clone());
            let last_of = team.filter(|team| state.world.members(team) == [*pane]).map(|team| {
                let disband = Intent::Disband { workspace: workspace.clone(), team: team.clone(), consent: Default::default() };
                (team, Box::new(preview(state, &disband)))
            });
            Preview { last_of, ..close_agent_offer(*pane).preview(refusal) }
        }
        Intent::Disband { team, .. } => {
            let refusal = capture::disband_blocked(state, workspace, team);
            if refusal == Some(Refusal::NotFound) {
                return empty(refusal);
            }
            disband_offer(state, workspace, team).preview(refusal)
        }
        Intent::CloseWorkspace { .. } => {
            let refusal = capture::close_workspace_blocked(state, workspace);
            close_workspace_offer(state, workspace).preview(refusal)
        }
        Intent::Archive { .. } => {
            let refusal = capture::archive_blocked(state, workspace);
            Preview { refusal, stops: state.world.panes_of(workspace), folders: Vec::new(), creations: Vec::new(), last_of: None }
        }
        _ => empty(None),
    }
}

/// What holds a place, as the machine knows it; the disk's word is the door's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum PlaceHeld {
    /// A team runs there.
    Team,
    /// A creation is making a worktree there.
    Creation,
    /// A cleanup not done yet holds it.
    Cleanup,
    /// Something is on disk there: the folder, or a branch of that name.
    Disk,
}

/// The answer of the place hint: the place a new team would get, or what
/// holds the place typed by hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Location {
    pub place: Option<Place>,
    pub held: Option<PlaceHeld>,
}

/// The first place a new team of this workspace would get now, from `from`,
/// with its number — the hint of the agent dialog; the decision is the
/// creation's own. A place the disk holds is skipped by asking past its number.
pub fn suggest(state: &State, workspace: &WorkspaceId, from: u32) -> Option<(u32, Place)> {
    let ws = state.world.workspaces.get(workspace)?;
    let base = ws.base.as_ref()?;
    let held = create::held(state, workspace);
    let n = places::first_free(&held, base, &ws.name, from);
    Some((n, Place { path: places::path(base, &ws.name, n), branch: places::branch(&ws.name, n) }))
}

/// What holds a place typed by hand, if anything does.
pub fn check(state: &State, workspace: &WorkspaceId, place: &Place) -> Option<PlaceHeld> {
    let teams = state.world.teams.values().filter(|team| &team.workspace == workspace);
    for team in teams {
        match &team.at {
            TeamAt::Attached { cwd, branch } if *cwd == place.path || branch.as_deref() == Some(place.branch.as_str()) => {
                return Some(PlaceHeld::Team);
            }
            TeamAt::Creating { ticket, .. } | TeamAt::Failed { ticket } if ticket.path == place.path || ticket.branch == place.branch => {
                return Some(PlaceHeld::Creation);
            }
            _ => {}
        }
    }
    let held = create::held(state, workspace);
    held.holds(&place.path, &place.branch).then_some(PlaceHeld::Cleanup)
}

/// One holder of a folder, for the worktree table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Claim {
    Team { team: TeamId },
    Session { session: SessionId },
    Creation { op: OpId },
    /// An operation deleting it, or a cleanup it owes.
    Removal { op: OpId },
}

/// Who holds this folder.
pub fn claims(state: &State, dir: &Dir) -> Vec<Claim> {
    let mut claims = Vec::new();
    for (id, team) in &state.world.teams {
        match &team.at {
            TeamAt::Attached { cwd, .. } if cwd == dir => claims.push(Claim::Team { team: id.clone() }),
            TeamAt::Failed { ticket } if &ticket.path == dir => claims.push(Claim::Team { team: id.clone() }),
            _ => {}
        }
    }
    for (&session, row) in &state.sessions {
        if !row.ended && row.dir.as_ref() == Some(dir) {
            claims.push(Claim::Session { session });
        }
    }
    for (&op, row) in &state.ops {
        if create::holds_folder(row, dir) {
            claims.push(Claim::Creation { op });
        } else if row.scope().folders.contains(dir) || matches!(&row.kind, Kind::Teardown(t) if t.removals.iter().any(|removal| &removal.path == dir)) {
            claims.push(Claim::Removal { op });
        }
    }
    claims
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::{update, Event, Load};
    use crate::world::{DeckFacts, PaneFacts, TeamAtFacts, TeamFacts, WorkspaceFacts};

    fn ws() -> WorkspaceId {
        WorkspaceId("ws-a".into())
    }

    fn team(name: &str) -> TeamId {
        TeamId(format!("team-{name}"))
    }

    /// team-1 alone in /wt/kd-app-1 with pane 1; team-2 and team-3 sharing
    /// /wt/shared, each with one pane; team-r in the root with pane 4.
    fn booted() -> State {
        let attached = |cwd: &str, branch: Option<&str>| TeamAtFacts::Attached { cwd: Dir::new(cwd), branch: branch.map(str::to_owned) };
        let pane = |n: u64, name: &str| PaneFacts { id: PaneId(n), team: Some(team(name)), remote: false, suspended: false };
        let deck = DeckFacts {
            workspaces: vec![WorkspaceFacts {
                id: ws(),
                name: "app".into(),
                cwd: Dir::new("/repo"),
                worktree_base: Some(Dir::new("/wt")),
                archived: false,
                archiving: false,
                teams: vec![
                    TeamFacts { id: team("1"), at: attached("/wt/kd-app-1", Some("kd/app/1")) },
                    TeamFacts { id: team("2"), at: attached("/wt/shared", None) },
                    TeamFacts { id: team("3"), at: attached("/wt/shared", None) },
                    TeamFacts { id: team("r"), at: attached("/repo", None) },
                ],
                panes: vec![pane(1, "1"), pane(2, "2"), pane(3, "3"), pane(4, "r")],
            }],
        };
        let state = crate::machine::State::start(Some(Vec::new()));
        let next = update(&state, Event::Handshake { ask: crate::ids::AskId(1), deck, load: Load::Loaded });
        next.state.expect("booted")
    }

    #[test]
    fn a_disband_offers_its_own_folder_but_never_the_root_or_one_another_team_keeps() {
        let state = booted();
        let own = preview(&state, &Intent::Disband { workspace: ws(), team: team("1"), consent: Default::default() });
        assert_eq!(own.folders.iter().map(|folder| folder.path.clone()).collect::<Vec<_>>(), [Dir::new("/wt/kd-app-1")]);
        assert_eq!(own.folders[0].branch.as_deref(), Some("kd/app/1"));
        assert_eq!(own.stops, [PaneId(1)]);
        let shared = preview(&state, &Intent::Disband { workspace: ws(), team: team("2"), consent: Default::default() });
        assert!(shared.folders.is_empty(), "team-3 stays in /wt/shared");
        let root = preview(&state, &Intent::Disband { workspace: ws(), team: team("r"), consent: Default::default() });
        assert!(root.folders.is_empty(), "the root is never a deletion target");
        let everything = preview(&state, &Intent::CloseWorkspace { workspace: ws(), consent: Default::default() });
        let paths: Vec<_> = everything.folders.iter().map(|folder| folder.path.as_str().to_owned()).collect();
        assert_eq!(paths, ["/wt/kd-app-1", "/wt/shared"], "the whole workspace leaves: the shared folder too, once");
    }

    #[test]
    fn closing_the_last_member_offers_the_disband_beside_it() {
        let state = booted();
        let last = preview(&state, &Intent::CloseAgent { workspace: ws(), pane: PaneId(1), consent: Default::default() });
        let (with, disband) = last.last_of.expect("the last member");
        assert_eq!(with, team("1"));
        assert_eq!(disband.folders.len(), 1);
        assert!(last.folders.is_empty(), "closing the agent alone deletes nothing");
    }

    #[test]
    fn the_hint_and_a_typed_place_meet_the_same_rule() {
        let state = booted();
        assert_eq!(suggest(&state, &ws(), 1), Some((2, Place { path: Dir::new("/wt/kd-app-2"), branch: "kd/app/2".into() })));
        let taken = Place { path: Dir::new("/wt/kd-app-1"), branch: "other".into() };
        assert_eq!(check(&state, &ws(), &taken), Some(PlaceHeld::Team));
        let branch = Place { path: Dir::new("/wt/new"), branch: "kd/app/1".into() };
        assert_eq!(check(&state, &ws(), &branch), Some(PlaceHeld::Team), "the branch is the place's key too");
        let free = Place { path: Dir::new("/wt/new"), branch: "new".into() };
        assert_eq!(check(&state, &ws(), &free), None);
    }

    #[test]
    fn a_shared_folder_names_every_team_in_it() {
        let state = booted();
        assert_eq!(claims(&state, &Dir::new("/wt/shared/")), [Claim::Team { team: team("2") }, Claim::Team { team: team("3") }]);
        assert!(claims(&state, &Dir::new("/wt/nobody")).is_empty());
    }
}
