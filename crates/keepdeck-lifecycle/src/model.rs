//! What the lifecycle is asked to do, what it answers, the consent a
//! destructive operation carries, and what each teardown does.

use crate::dir::Dir;
use crate::ids::{AttemptId, OpId, PaneId, PermitId, TeamId, WorkspaceId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A row the deck owns — a workspace, a team or a pane as the deck spells it —
/// carried verbatim. The lifecycle never reads it: the deck's applicator
/// builds its row from it, with the ids the machine gave.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/", type = "unknown")]
pub struct Draft(pub serde_json::Value);

/// A new worktree's folder and branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Place {
    pub path: Dir,
    pub branch: String,
}

/// Where a new team runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Site {
    /// The workspace's own folder.
    Root,
    /// A folder that is there: a worktree, or a plain directory to attach to.
    Existing { cwd: Dir },
    /// A new worktree. The machine gives the place; a place typed by hand is
    /// checked by the same rule. `base` absent: the repository's HEAD.
    New { place: Option<Place>, base: Option<String> },
}

/// A recorded conversation: which agent, and its id in that agent's store.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct SessionKey {
    pub agent: String,
    pub session: String,
}

/// How a recorded conversation continues in a new pane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Continuation {
    /// The same conversation, in the folder it was recorded in.
    Resume,
    /// A copy, carried into the target team's folder by the plugin's hook.
    Fork,
}

/// The team a continued conversation lands on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Landing {
    Team { team: TeamId },
    NewTeam { team: TeamId, site: Site, draft: Draft },
}

/// What a confirmed Close may delete: exactly what its dialog offered and the
/// person agreed to. Empty — keep every folder.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Consent {
    /// The folders, as the preview found them.
    pub folders: Vec<Folder>,
    /// Creations still out when the dialog opened: what their tickets make is
    /// deleted too, since no folder could be named for them yet.
    pub tickets: Vec<OpId>,
}

/// A worktree a Close may delete.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Folder {
    pub repo: Dir,
    pub path: Dir,
    pub branch: Option<String>,
    /// The checkout was there when the person agreed. A branch of a checkout
    /// that is gone is deleted only on this evidence.
    pub present: bool,
}

/// What a door asks the lifecycle to do — the closed set; an operation the
/// set does not name is a new variant here, never a flag from TS.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Intent {
    CreateWorkspace { workspace: WorkspaceId, name: String, cwd: Dir, worktree_base: Option<Dir>, draft: Draft },
    /// The workspace's name or worktree base changed: new places are named
    /// and put after them.
    Describe { workspace: WorkspaceId, name: String, worktree_base: Option<Dir> },
    CreateTeam { workspace: WorkspaceId, team: TeamId, site: Site, draft: Draft, members: Vec<Draft> },
    Retry { workspace: WorkspaceId, team: TeamId },
    Seat { workspace: WorkspaceId, team: TeamId, member: Draft },
    Continue {
        workspace: WorkspaceId,
        landing: Landing,
        source: SessionKey,
        how: Continuation,
        member: Draft,
    },
    /// A member whose team's folder is gone moves to the workspace's root
    /// team; `root` names that team if the workspace has none yet.
    Relocate { workspace: WorkspaceId, pane: PaneId, root: TeamId },
    CloseAgent { workspace: WorkspaceId, pane: PaneId, consent: Consent },
    Disband { workspace: WorkspaceId, team: TeamId, consent: Consent },
    CloseWorkspace { workspace: WorkspaceId, consent: Consent },
    Archive { workspace: WorkspaceId },
    Restore { workspace: WorkspaceId },
    Restart { workspace: WorkspaceId, pane: PaneId },
    RemoveUnheld { workspace: WorkspaceId, path: Dir, tag: Option<String> },
    Suspend { workspace: WorkspaceId, pane: PaneId },
    Resume { workspace: WorkspaceId, pane: PaneId },
}

/// How an operation meets another over the same objects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// One at a time over a workspace, team, pane or folder; the next gets
    /// `Busy`. Close may take over a creation and an archive.
    Exclusive,
    /// Seat, continue, relocate: one after another through the queue, never
    /// cancelling each other; refused only when their target is leaving,
    /// archiving or archived.
    Additive,
    /// Suspend and resume: no capture of their own — they are refused while
    /// their pane is taken.
    Gated,
}

impl Intent {
    pub fn workspace(&self) -> &WorkspaceId {
        match self {
            Intent::CreateWorkspace { workspace, .. }
            | Intent::Describe { workspace, .. }
            | Intent::CreateTeam { workspace, .. }
            | Intent::Retry { workspace, .. }
            | Intent::Seat { workspace, .. }
            | Intent::Continue { workspace, .. }
            | Intent::Relocate { workspace, .. }
            | Intent::CloseAgent { workspace, .. }
            | Intent::Disband { workspace, .. }
            | Intent::CloseWorkspace { workspace, .. }
            | Intent::Archive { workspace }
            | Intent::Restore { workspace }
            | Intent::Restart { workspace, .. }
            | Intent::RemoveUnheld { workspace, .. }
            | Intent::Suspend { workspace, .. }
            | Intent::Resume { workspace, .. } => workspace,
        }
    }

    pub fn class(&self) -> Class {
        match self {
            Intent::Seat { .. } | Intent::Continue { .. } | Intent::Relocate { .. } => Class::Additive,
            Intent::Suspend { .. } | Intent::Resume { .. } | Intent::Describe { .. } => Class::Gated,
            Intent::CreateWorkspace { .. }
            | Intent::CreateTeam { .. }
            | Intent::Retry { .. }
            | Intent::CloseAgent { .. }
            | Intent::Disband { .. }
            | Intent::CloseWorkspace { .. }
            | Intent::Archive { .. }
            | Intent::Restore { .. }
            | Intent::Restart { .. }
            | Intent::RemoveUnheld { .. } => Class::Exclusive,
        }
    }

    /// The operation has a step that cannot be taken back — a worktree
    /// created or removed, a conversation carried — so its journal entry is
    /// on disk before that step, and «accepted» waits for it.
    pub fn journaled(&self) -> bool {
        match self {
            Intent::CreateTeam { site, .. } => matches!(site, Site::New { .. }),
            Intent::Continue { how, landing, .. } => {
                *how == Continuation::Fork || matches!(landing, Landing::NewTeam { site: Site::New { .. }, .. })
            }
            Intent::Retry { .. }
            | Intent::CloseAgent { .. }
            | Intent::Disband { .. }
            | Intent::CloseWorkspace { .. }
            | Intent::Archive { .. }
            | Intent::RemoveUnheld { .. } => true,
            Intent::CreateWorkspace { .. }
            | Intent::Describe { .. }
            | Intent::Seat { .. }
            | Intent::Relocate { .. }
            | Intent::Restore { .. }
            | Intent::Restart { .. }
            | Intent::Suspend { .. }
            | Intent::Resume { .. } => false,
        }
    }
}

/// Why an intent was refused. Kinds and data only: the words for each are
/// the presentation's, one set per kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Refusal {
    /// Its target is already being closed.
    AlreadyClosing,
    /// Another exclusive operation holds its target.
    Busy,
    /// Its target is not there.
    NotFound,
    /// The boot barrier is still up: nothing launches or removes before boot
    /// is reconciled.
    BarrierUp,
    /// The journal entry could not be written; nothing was done.
    JournalUnavailable,
    /// The journal entry could not be written, nor taken back: the operation
    /// may finish at the next launch.
    JournalStuck,
    /// The place asked for is held — by a team, a creation, a cleanup not yet
    /// done, or something on disk.
    LocationHeld,
    /// Its target is leaving.
    TargetLeaving,
    /// Its workspace is archived, or being archived.
    Archived,
    /// The sessions machine is gone: nothing launches until a restart.
    SessionsDown,
    /// The fork step did not answer within its deadline.
    ForkStepExpired,
    /// A data owner refused its command, with the owner's own kind (a role
    /// already taken, a session another pane holds), carried back verbatim.
    Rejected { reason: String },
}

/// The ids an accepted intent was given.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "lifecycle/")]
pub struct Minted {
    pub workspace: Option<WorkspaceId>,
    pub team: Option<TeamId>,
    pub panes: Vec<PaneId>,
}

/// The one answer each ask gets, once its work allows: an intent accepted —
/// a journaled one only once its entry is on disk — a launch permit given, a
/// launch admitted, or a refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Answer {
    Accepted { op: OpId, minted: Minted },
    Leased { permit: PermitId },
    Admitted { attempt: AttemptId },
    /// The boot handshake: the operations the journal left, now finishing.
    Booted { finishing: Vec<OpId> },
    Refused { refusal: Refusal },
}

impl Answer {
    pub fn refused(refusal: Refusal) -> Answer {
        Answer::Refused { refusal }
    }
}

/// What a waiting door hands back: the machine's answer, or what the door
/// knows when there is none to give.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "lifecycle/")]
pub enum Reply {
    Answered { answer: Answer },
    /// The machine was gone before the ask was sent: nothing was done.
    Unavailable,
    /// The machine went after the ask was sent, unanswered: the next launch
    /// settles it.
    Unknown,
}

/// What a teardown does to the deck's rows. Every teardown stops its
/// sessions by the one stop rule of the sessions machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rows {
    RemovePane,
    RemoveTeam,
    RemoveWorkspace,
    MarkArchived,
    MarkSuspended,
    /// The row stays as it is.
    Keep,
}

/// What a teardown forgets of the data kept for its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Forget {
    /// Nothing: the data stays for when the target comes back.
    Nothing,
    /// The pane's mail queue.
    PaneMail,
    /// The team's tasks and its members' mail.
    Team,
    /// Everything kept for the workspace — boards, artifacts, its MCP
    /// records, plugin folders, staged skills, planting records and mail.
    /// The workspace's own authored skills stay, as today.
    Workspace,
}

/// What one teardown does — chosen by the operation itself, never passed in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Strategy {
    pub rows: Rows,
    /// Folders are deleted by consent, and only those nobody else holds.
    pub delete_by_consent: bool,
    pub forget: Forget,
    /// The plantings are taken out of the folders it leaves. A pane's close
    /// takes back only a folder nobody else is in.
    pub take_plantings: bool,
}

/// The teardowns, by the operation that runs them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Teardown {
    CloseAgent,
    Disband,
    CloseWorkspace,
    Archive,
    Restart,
    Suspend,
}

impl Teardown {
    pub fn strategy(self) -> Strategy {
        let strategy = |rows, delete_by_consent, forget, take_plantings| Strategy { rows, delete_by_consent, forget, take_plantings };
        match self {
            Teardown::CloseAgent => strategy(Rows::RemovePane, false, Forget::PaneMail, true),
            Teardown::Disband => strategy(Rows::RemoveTeam, true, Forget::Team, true),
            Teardown::CloseWorkspace => strategy(Rows::RemoveWorkspace, true, Forget::Workspace, true),
            Teardown::Archive => strategy(Rows::MarkArchived, false, Forget::Nothing, true),
            Teardown::Restart => strategy(Rows::Keep, false, Forget::Nothing, false),
            Teardown::Suspend => strategy(Rows::MarkSuspended, false, Forget::Nothing, false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ws() -> WorkspaceId {
        WorkspaceId("ws-a1".into())
    }

    fn team() -> TeamId {
        TeamId("team-b2".into())
    }

    fn draft() -> Draft {
        Draft(json!({ "agentType": "claude", "role": "peer" }))
    }

    #[test]
    fn only_seat_continue_and_relocate_are_additive_and_only_suspend_and_resume_are_gated() {
        let additive = [
            Intent::Seat { workspace: ws(), team: team(), member: draft() },
            Intent::Relocate { workspace: ws(), pane: PaneId(1), root: team() },
            Intent::Continue {
                workspace: ws(),
                landing: Landing::Team { team: team() },
                source: SessionKey { agent: "claude".into(), session: "s".into() },
                how: Continuation::Resume,
                member: draft(),
            },
        ];
        assert!(additive.iter().all(|intent| intent.class() == Class::Additive));
        assert_eq!(Intent::Suspend { workspace: ws(), pane: PaneId(1) }.class(), Class::Gated);
        assert_eq!(Intent::Resume { workspace: ws(), pane: PaneId(1) }.class(), Class::Gated);
        assert_eq!(Intent::Archive { workspace: ws() }.class(), Class::Exclusive);
        assert_eq!(Intent::Disband { workspace: ws(), team: team(), consent: Consent::default() }.class(), Class::Exclusive);
    }

    #[test]
    fn a_journal_entry_is_kept_only_by_operations_with_a_step_that_cannot_be_taken_back() {
        let team_at = |site| Intent::CreateTeam { workspace: ws(), team: team(), site, draft: draft(), members: vec![] };
        assert!(team_at(Site::New { place: None, base: None }).journaled(), "git worktree add");
        assert!(!team_at(Site::Root).journaled(), "no folder is made");
        assert!(!team_at(Site::Existing { cwd: Dir::new("/repo/wt") }).journaled());

        let continued = |how, landing| Intent::Continue {
            workspace: ws(),
            landing,
            source: SessionKey { agent: "claude".into(), session: "s".into() },
            how,
            member: draft(),
        };
        assert!(continued(Continuation::Fork, Landing::Team { team: team() }).journaled(), "carrying a conversation cannot be undone");
        assert!(!continued(Continuation::Resume, Landing::Team { team: team() }).journaled());
        let new_worktree = Landing::NewTeam { team: team(), site: Site::New { place: None, base: None }, draft: draft() };
        assert!(continued(Continuation::Resume, new_worktree).journaled(), "a resume into a new worktree creates one");

        assert!(Intent::CloseAgent { workspace: ws(), pane: PaneId(1), consent: Consent::default() }.journaled());
        assert!(Intent::RemoveUnheld { workspace: ws(), path: Dir::new("/repo/wt"), tag: None }.journaled());
        assert!(!Intent::Restart { workspace: ws(), pane: PaneId(1) }.journaled(), "a restart keeps no entry");
        assert!(!Intent::Seat { workspace: ws(), team: team(), member: draft() }.journaled());
    }

    #[test]
    fn each_teardown_has_its_own_strategy() {
        let close_agent = Teardown::CloseAgent.strategy();
        assert_eq!((close_agent.rows, close_agent.forget), (Rows::RemovePane, Forget::PaneMail));
        assert!(!close_agent.delete_by_consent, "closing one agent never deletes a folder");

        let disband = Teardown::Disband.strategy();
        assert_eq!((disband.rows, disband.forget), (Rows::RemoveTeam, Forget::Team));
        assert!(disband.delete_by_consent);

        let workspace = Teardown::CloseWorkspace.strategy();
        assert_eq!((workspace.rows, workspace.forget), (Rows::RemoveWorkspace, Forget::Workspace));
        assert!(workspace.delete_by_consent && workspace.take_plantings);

        let archive = Teardown::Archive.strategy();
        assert_eq!((archive.rows, archive.forget), (Rows::MarkArchived, Forget::Nothing));
        assert!(!archive.delete_by_consent && archive.take_plantings, "archive keeps folders and takes plantings back");

        let restart = Teardown::Restart.strategy();
        assert_eq!((restart.rows, restart.forget), (Rows::Keep, Forget::Nothing));
        let suspend = Teardown::Suspend.strategy();
        assert_eq!(suspend.rows, Rows::MarkSuspended);
        assert!(!restart.take_plantings && !suspend.take_plantings);
    }

    #[test]
    fn an_intent_crosses_the_wire_as_a_tagged_object_with_the_decks_own_ids() {
        let intent = Intent::CloseAgent { workspace: ws(), pane: PaneId(7), consent: Consent::default() };
        let wire = serde_json::to_value(&intent).unwrap();
        assert_eq!(wire, json!({ "kind": "closeAgent", "workspace": "ws-a1", "pane": "pane-7", "consent": { "folders": [], "tickets": [] } }));
        assert_eq!(serde_json::from_value::<Intent>(wire).unwrap(), intent);
    }

    #[test]
    fn a_refusal_from_an_owner_carries_its_own_kind_back() {
        let refused = Answer::Refused { refusal: Refusal::Rejected { reason: "taken".into() } };
        let wire = serde_json::to_value(&refused).unwrap();
        assert_eq!(wire, json!({ "kind": "refused", "refusal": { "kind": "rejected", "reason": "taken" } }));
        assert_eq!(serde_json::from_value::<Answer>(wire).unwrap(), refused);
    }
}
