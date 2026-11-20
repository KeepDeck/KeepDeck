//! What the machine asks of the data owners that stay in TS, and what they
//! answer. A command stands in the snapshot under its exact id until its
//! owner answers; it is never withdrawn.

use crate::dir::Dir;
use crate::ids::{CommandId, OpId, PaneId, TeamId, WorkspaceId};
use crate::model::{Draft, SessionKey};
use serde::{Deserialize, Serialize};

/// Who carries a command out, with its own existing actions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    /// The deck's reducer — the one writer of deck.json.
    Deck,
    /// The task boards.
    Boards,
    Mail,
    /// A pane's launch state: its plan, with the secrets in it, fork
    /// scaffolding, telemetry.
    RunState,
    Notices,
    /// The fork step: the plugin's hook that carries a conversation over.
    ForkStep,
}

/// Where a team row says it runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamPlace {
    Attached { cwd: Dir, branch: Option<String> },
    /// Its worktree is being created by the ticket of `op`.
    Provisioning { op: OpId, path: Dir, branch: String, base: Option<String> },
}

/// One command, by its owner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cmd {
    // ------------------------------------------------------------ the deck
    AddWorkspace { workspace: WorkspaceId, draft: Draft },
    AddTeam { workspace: WorkspaceId, team: TeamId, draft: Draft, place: TeamPlace },
    /// The team's worktree is there: it runs from now on.
    SettleTeam { workspace: WorkspaceId, team: TeamId, cwd: Dir, branch: Option<String> },
    /// The team's creation failed; its card offers Retry.
    FailTeam { workspace: WorkspaceId, team: TeamId, reason: String },
    /// A new pane. The applicator asks the role rule and the session check
    /// in the same step, and answers «rejected» with their kind.
    AddPane { workspace: WorkspaceId, team: TeamId, pane: PaneId, draft: Draft },
    /// A member moves to the workspace's root team, made from `root` when the
    /// workspace has none; its old session is reset in the same step.
    MovePane { workspace: WorkspaceId, pane: PaneId, to: TeamId, root: Option<Draft> },
    RemovePane { workspace: WorkspaceId, pane: PaneId },
    RemoveTeam { workspace: WorkspaceId, team: TeamId },
    RemoveWorkspace { workspace: WorkspaceId },
    MarkArchived { workspace: WorkspaceId },
    ClearArchived { workspace: WorkspaceId },
    MarkSuspended { workspace: WorkspaceId, pane: PaneId },
    ClearSuspended { workspace: WorkspaceId, pane: PaneId },
    // ------------------------------------------------------------ the boards
    DeleteTeamTasks { workspace: WorkspaceId, team: TeamId },
    ForgetBoards { workspace: WorkspaceId },
    // ------------------------------------------------------------ mail
    ForgetPaneMail { workspace: WorkspaceId, pane: PaneId },
    ForgetWorkspaceMail { workspace: WorkspaceId },
    // ------------------------------------------------------------ launch state
    /// End what this launch keeps for the pane — its plan and the secrets in
    /// it — before its process goes.
    Retire { workspace: WorkspaceId, pane: PaneId },
    /// Build the plan that resumes `source` in the pane about to be added.
    PrepareResume { workspace: WorkspaceId, pane: PaneId, source: SessionKey },
    /// Drop what the fork attempt of `op` built; a late build of it is refused.
    DropBuild { op: OpId },
    /// Say whether the pane's launch is bound to its fork conversation — the
    /// binding the binding lane accepted.
    ReportBinding { workspace: WorkspaceId, pane: PaneId, op: OpId },
    // ------------------------------------------------------------ notices
    WorktreeNotDeleted { workspace: WorkspaceId, path: Dir, reason: String },
    // ------------------------------------------------------------ the fork step
    /// Carry `source` into `cwd` for `pane`, by the agent plugin's hook.
    Fork { workspace: WorkspaceId, pane: PaneId, source: SessionKey, cwd: Dir },
}

impl Cmd {
    pub fn owner(&self) -> Owner {
        match self {
            Cmd::AddWorkspace { .. }
            | Cmd::AddTeam { .. }
            | Cmd::SettleTeam { .. }
            | Cmd::FailTeam { .. }
            | Cmd::AddPane { .. }
            | Cmd::MovePane { .. }
            | Cmd::RemovePane { .. }
            | Cmd::RemoveTeam { .. }
            | Cmd::RemoveWorkspace { .. }
            | Cmd::MarkArchived { .. }
            | Cmd::ClearArchived { .. }
            | Cmd::MarkSuspended { .. }
            | Cmd::ClearSuspended { .. } => Owner::Deck,
            Cmd::DeleteTeamTasks { .. } | Cmd::ForgetBoards { .. } => Owner::Boards,
            Cmd::ForgetPaneMail { .. } | Cmd::ForgetWorkspaceMail { .. } => Owner::Mail,
            Cmd::Retire { .. } | Cmd::PrepareResume { .. } | Cmd::DropBuild { .. } | Cmd::ReportBinding { .. } => {
                Owner::RunState
            }
            Cmd::WorktreeNotDeleted { .. } => Owner::Notices,
            Cmd::Fork { .. } => Owner::ForkStep,
        }
    }
}

/// A command under its exact name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub id: CommandId,
    pub cmd: Cmd,
}

/// The deck's revision a deck command's answer was taken at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revision(pub u64);

/// What an owner answers. A deck command is durable only once a saved deck
/// at or past its revision is reported; a rejected one is settled at once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Applied { revision: Option<Revision> },
    /// What the command does was already there — a repeat after a restart.
    Unchanged { revision: Option<Revision> },
    Rejected { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ws() -> WorkspaceId {
        WorkspaceId("ws-a1".into())
    }

    #[test]
    fn every_command_names_the_one_owner_that_carries_it_out() {
        let pane = PaneId(3);
        let team = TeamId("team-b2".into());
        assert_eq!(Cmd::RemoveTeam { workspace: ws(), team: team.clone() }.owner(), Owner::Deck);
        assert_eq!(Cmd::DeleteTeamTasks { workspace: ws(), team }.owner(), Owner::Boards);
        assert_eq!(Cmd::ForgetPaneMail { workspace: ws(), pane }.owner(), Owner::Mail);
        assert_eq!(Cmd::Retire { workspace: ws(), pane }.owner(), Owner::RunState);
        assert_eq!(Cmd::DropBuild { op: OpId(1) }.owner(), Owner::RunState);
        let path = Dir::new("/repo/wt");
        assert_eq!(Cmd::WorktreeNotDeleted { workspace: ws(), path: path.clone(), reason: "busy".into() }.owner(), Owner::Notices);
        let source = SessionKey { agent: "claude".into(), session: "s".into() };
        assert_eq!(Cmd::Fork { workspace: ws(), pane, source, cwd: path }.owner(), Owner::ForkStep);
    }

    #[test]
    fn a_command_crosses_the_wire_under_its_exact_id() {
        let command = Command { id: CommandId { op: OpId(4), index: 2 }, cmd: Cmd::RemovePane { workspace: ws(), pane: PaneId(9) } };
        let wire = serde_json::to_value(&command).unwrap();
        let expected = json!({ "id": { "op": 4, "index": 2 }, "cmd": { "kind": "removePane", "workspace": "ws-a1", "pane": "pane-9" } });
        assert_eq!(wire, expected);
        assert_eq!(serde_json::from_value::<Command>(wire).unwrap(), command);
    }
}
