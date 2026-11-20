//! The living part of the deck, as the machine keeps it: which workspaces,
//! teams and panes there are, where each team runs, who is on it. Boot builds
//! it from the deck's facts and the journal; after that only the machine's
//! operations change it, as their deck commands become durable.

use crate::dir::Dir;
use crate::ids::{OpId, PaneId, TeamId, WorkspaceId};
use crate::journal::Ticket;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// What the deck says, at the boot handshake.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct DeckFacts {
    pub workspaces: Vec<WorkspaceFacts>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub struct WorkspaceFacts {
    pub id: WorkspaceId,
    pub name: String,
    pub cwd: Dir,
    /// Where its new worktrees go; none: a new worktree needs a place typed
    /// by hand.
    pub worktree_base: Option<Dir>,
    pub archived: bool,
    /// The deck's archive marker says an archive was under way.
    #[serde(default)]
    pub archiving: bool,
    pub teams: Vec<TeamFacts>,
    pub panes: Vec<PaneFacts>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct TeamFacts {
    pub id: TeamId,
    pub at: TeamAtFacts,
}

/// Where the deck says a team runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum TeamAtFacts {
    Attached { cwd: Dir, branch: Option<String> },
    /// A creation the deck saved as going on; boot reconciles it with the
    /// journal.
    Provisioning { path: Dir, branch: Option<String> },
    /// A roster with no folder of its own: its members run in the root.
    Unplaced,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct PaneFacts {
    pub id: PaneId,
    pub team: Option<TeamId>,
    /// A remote pane runs on an endpoint, in no folder of ours.
    pub remote: bool,
    pub suspended: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub cwd: Dir,
    pub base: Option<Dir>,
    pub archived: bool,
}

/// Where a team runs, as the machine knows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamAt {
    Attached { cwd: Dir, branch: Option<String> },
    /// Its worktree is being made by `op`'s ticket.
    Creating { op: OpId, ticket: Ticket },
    /// Its creation failed; the place stays the team's until Retry or Close.
    Failed { ticket: Ticket },
    Unplaced,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Team {
    pub workspace: WorkspaceId,
    pub at: TeamAt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pane {
    pub workspace: WorkspaceId,
    pub team: Option<TeamId>,
    pub remote: bool,
    pub suspended: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct World {
    pub workspaces: BTreeMap<WorkspaceId, Workspace>,
    pub teams: BTreeMap<TeamId, Team>,
    pub panes: BTreeMap<PaneId, Pane>,
}

impl World {
    /// The deck's facts as the machine's model. A team the deck saved as
    /// provisioning becomes a failed creation here — boot decides with the
    /// journal what it really is.
    pub fn from_facts(facts: &DeckFacts) -> World {
        let mut world = World::default();
        for ws in &facts.workspaces {
            world.workspaces.insert(
                ws.id.clone(),
                Workspace { name: ws.name.clone(), cwd: ws.cwd.clone(), base: ws.worktree_base.clone(), archived: ws.archived },
            );
            for team in &ws.teams {
                let at = match &team.at {
                    TeamAtFacts::Attached { cwd, branch } => TeamAt::Attached { cwd: cwd.clone(), branch: branch.clone() },
                    TeamAtFacts::Provisioning { .. } | TeamAtFacts::Unplaced => TeamAt::Unplaced,
                };
                world.teams.insert(team.id.clone(), Team { workspace: ws.id.clone(), at });
            }
            for pane in &ws.panes {
                world.panes.insert(
                    pane.id,
                    Pane { workspace: ws.id.clone(), team: pane.team.clone(), remote: pane.remote, suspended: pane.suspended },
                );
            }
        }
        world
    }

    /// The folder a team's members run in: its own, or the workspace's when
    /// it has none yet.
    pub fn team_cwd(&self, team: &TeamId) -> Option<Dir> {
        let team = self.teams.get(team)?;
        match &team.at {
            TeamAt::Attached { cwd, .. } => Some(cwd.clone()),
            TeamAt::Creating { .. } | TeamAt::Failed { .. } | TeamAt::Unplaced => {
                self.workspaces.get(&team.workspace).map(|ws| ws.cwd.clone())
            }
        }
    }

    /// The folder a pane runs in; none for a remote pane.
    pub fn pane_cwd(&self, pane: &PaneId) -> Option<Dir> {
        let pane = self.panes.get(pane)?;
        if pane.remote {
            return None;
        }
        match &pane.team {
            Some(team) => self.team_cwd(team),
            None => self.workspaces.get(&pane.workspace).map(|ws| ws.cwd.clone()),
        }
    }

    pub fn members(&self, team: &TeamId) -> Vec<PaneId> {
        self.panes.iter().filter(|(_, pane)| pane.team.as_ref() == Some(team)).map(|(&id, _)| id).collect()
    }

    pub fn teams_of(&self, workspace: &WorkspaceId) -> Vec<TeamId> {
        self.teams.iter().filter(|(_, team)| &team.workspace == workspace).map(|(id, _)| id.clone()).collect()
    }

    pub fn panes_of(&self, workspace: &WorkspaceId) -> Vec<PaneId> {
        self.panes.iter().filter(|(_, pane)| &pane.workspace == workspace).map(|(&id, _)| id).collect()
    }

    /// The highest pane number the deck holds.
    pub fn top_pane(&self) -> Option<u64> {
        self.panes.keys().map(|id| id.0).max()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn facts() -> DeckFacts {
        DeckFacts {
            workspaces: vec![WorkspaceFacts {
                id: WorkspaceId("ws-a".into()),
                name: "app".into(),
                cwd: Dir::new("/repo"),
                worktree_base: Some(Dir::new("/wt")),
                archived: false,
                archiving: false,
                teams: vec![
                    TeamFacts {
                        id: TeamId("team-1".into()),
                        at: TeamAtFacts::Attached { cwd: Dir::new("/wt/kd-app-1/"), branch: Some("kd/app/1".into()) },
                    },
                    TeamFacts { id: TeamId("team-2".into()), at: TeamAtFacts::Unplaced },
                    TeamFacts {
                        id: TeamId("team-3".into()),
                        at: TeamAtFacts::Provisioning { path: Dir::new("/wt/kd-app-3"), branch: None },
                    },
                ],
                panes: vec![
                    PaneFacts { id: PaneId(4), team: Some(TeamId("team-1".into())), remote: false, suspended: false },
                    PaneFacts { id: PaneId(9), team: Some(TeamId("team-2".into())), remote: false, suspended: true },
                    PaneFacts { id: PaneId(2), team: None, remote: true, suspended: false },
                ],
            }],
        }
    }

    #[test]
    fn a_member_runs_in_its_teams_folder_and_a_team_without_one_in_the_root() {
        let world = World::from_facts(&facts());
        assert_eq!(world.pane_cwd(&PaneId(4)), Some(Dir::new("/wt/kd-app-1")));
        assert_eq!(world.pane_cwd(&PaneId(9)), Some(Dir::new("/repo")), "an unplaced team runs in the root");
        assert_eq!(world.pane_cwd(&PaneId(2)), None, "a remote pane is in no folder of ours");
        assert_eq!(world.members(&TeamId("team-1".into())), [PaneId(4)]);
    }

    #[test]
    fn a_creation_the_deck_saved_as_going_on_is_not_trusted_as_a_folder() {
        let world = World::from_facts(&facts());
        assert_eq!(world.teams[&TeamId("team-3".into())].at, TeamAt::Unplaced, "boot settles it with the journal");
        assert_eq!(world.top_pane(), Some(9));
    }
}
