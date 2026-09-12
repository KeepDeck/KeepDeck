import { useRef, useState } from "react";
import {
  type AgentDialogResult,
  type AgentDialogTarget,
  type AgentInfo,
  type AgentType,
  type DirectoryState,
  type SessionPickRow,
} from "../domain/agents";
import {
  autoTeamName,
  baseName,
  directoryState,
  findTeam,
  findWorkspaceByRef,
  firstFreeTeamWorktree,
  membersOf,
  nextTeamSeq,
  paneId,
  parentDir,
  sessionClaimant,
  type Workspace,
} from "../domain/deck";
import { handleFromHit } from "../domain/journal";
import { describeError } from "../ipc/log";
import { indexSearch } from "../ipc/history";
import type { Page } from "./usePagedSessionSearch";
import { inspectRepo, probeWorktree, suggestWorktree } from "../ipc/worktree";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { mintAgentSeq } from "./ids";
import { getSettings } from "./settingsManager";
import {
  firstFreeTeamWorktreeFor,
  nextAgentIndex,
  nextAgentType,
} from "./newAgentDefaults";
import { useAppRuntime } from "./runtimeContext";
import type { DirectoryHolder } from "./agentOrchestrator";
import type { DoorName, DoorOutcome } from "./agentDoors";
import { roleChoiceView, type RoleChoice } from "../presentation/roleChoiceView";
import type { Deck } from "./useDeck";

/** Where a door's refusal is heard. A door the person opened must fail
 * VISIBLY — a dialog that just closes reads as success — and `confirm`
 * answers nothing, so the notice is a callback rather than a rejected
 * promise the caller would have to remember to catch. Which door refused,
 * and in what words, is the owner's answer (`agentDoors`); this only says
 * where each is heard. */
export interface AgentDialogNotices {
  onResumeFailed(message: string): void;
  onForkFailed(message: string): void;
  /** The workspace refused the pane — it filled up, or it is gone. The
   * dialog has already closed by then, so without this the agent the user
   * asked for simply never appears. */
  onCreateFailed(message: string): void;
  /** The workspace refused the team — its directory is a team's already,
   * its name is taken, or it is gone. Same reason: the dialog is closed. */
  onTeamFailed(message: string): void;
}

/**
 * The consent a team asks for when its directory is another team's already.
 *
 * Teams sharing a directory is a way of working, not a mistake — so the door
 * does not refuse, it names who is there and asks. `confirm` re-issues the
 * SAME create carrying the answer; `cancel` drops it. The "+ Team" dialog is
 * already closed by then, exactly as it is for any other outcome.
 */
export interface SharedDirectoryAsk {
  holder: DirectoryHolder;
  /** The directory both teams would work in, as the request spelled it. */
  path: string;
  confirm(): void;
  cancel(): void;
}

/** What the dialog is opened FOR, as the caller says it: a new team, or a
 * member of the team `teamId`. */
export type AgentDialogOpening = { kind: "new-team" } | { kind: "member"; teamId: string };

/** Everything the agent dialog ("+ Team" / "Add member") needs to render,
 * captured at open time. */
export interface AgentDialogSpec {
  workspace: WorkspaceRef;
  agentId: string;
  index: number;
  /** What the dialog is for — a new team with a suggested name, or a member
   * of a team that exists, named so the title can say so. */
  target: AgentDialogTarget;
  /** The role picker's data, built against what the target team holds —
   * the view decides nothing about roles itself. */
  roles: RoleChoice;
  defaultAgentType: AgentType;
  /** The YOLO toggle's starting position ([F6] global preference). */
  defaultYolo: boolean;
  /** Whether the Experimental “Remote agents” setting is on — gates the
   *  dialog's "Where: Remote" option regardless of an agent's capability. */
  remoteEnabled: boolean;
  /** The workspace repo when its cwd is a git repo — enables the worktree
   * location field; null → the agent just runs in the workspace cwd. */
  repo: { cwd: string; branch: string | null } | null;
  /** Prefilled worktree path — non-empty only when the workspace has a base
   * folder ([F2]: suggest a default only then). */
  suggestedPath: string;
  /** Prefilled branch for a new worktree. */
  suggestedBranch: string;
}

/**
 * The agent dialog's presentation: opens it with per-workspace suggestions,
 * hands a confirmed result to the doors (`agentDoors` — what a confirmed
 * dialog DOES lives there, with its landings and its refusal words), and
 * shows the answer — a notice for a refusal, a standing question for a
 * directory another team works in. What this hook holds is UI state and the
 * form's data sources; it decides nothing about teams, roles or landings.
 */
export function useAgentDialog(
  deck: Deck,
  agents: AgentInfo[],
  /** Where a "Start from" continuation reports its failure. Explicit rather
   * than optional: an optional here is what forced the argument below to
   * carry a default, and that default is the bug it exists to prevent. */
  notices: AgentDialogNotices,
  /** paneId → the missing directory, from the revive sweep. A pane stuck on a
   * gone folder is going nowhere, so the picker must call its session stopped
   * like the tile and the tray already do — the model alone still reads that
   * pane as rising.
   *
   * REQUIRED, like `paneSuspendBlock`'s: a default is how the next surface
   * omits it, compiles, and tells the user a dead pane is running again. */
  blockedPanes: Record<string, string>,
) {
  const { agentDoors } = useAppRuntime();
  const [dialog, setDialog] = useState<AgentDialogSpec | null>(null);
  /** The open "create anyway?" question, if one is standing. */
  const [sharedAsk, setSharedAsk] = useState<SharedDirectoryAsk | null>(null);
  /** The standing question as the LATE half of `openFor` sees it: that half
   * runs after its IPC awaits, by which time a form opened before the
   * question could otherwise mount on top of it. */
  const askRef = useRef<SharedDirectoryAsk | null>(null);
  askRef.current = sharedAsk;
  const deckRef = useRef(deck);
  deckRef.current = deck;

  /** Per-index name suggestion for `ws`, IPC failures flattened to null. */
  const suggestFor = (ws: Workspace) => (index: number) =>
    suggestWorktree(ws.name, index).catch(() => null);

  /** Disk probe for suggestion filtering, IPC failures flattened to null
   * (= don't filter — the dialog's live hint still guards the create). */
  const probeFor = (path: string) => probeWorktree(path).catch(() => null);

  const openFor = async (ws: Workspace, opening: AgentDialogOpening = { kind: "new-team" }) => {
    const workspace = { id: ws.id, instance: ws.instance };
    const seq = mintAgentSeq();
    const index = nextAgentIndex(ws);
    const defaultType = nextAgentType(agents, ws);
    if (opening.kind === "member") {
      // A member runs in its team's directory: nothing to inspect, no
      // location to suggest — the dialog asks for the agent and nothing
      // about where. A team gone by the time the door is pressed opens no
      // dialog at all.
      const team = findTeam(ws, opening.teamId);
      if (!team) return;
      setDialog({
        workspace,
        agentId: paneId(seq),
        index,
        target: {
          kind: "member",
          teamId: team.id,
          teamName: team.name,
          // Null while the create is out: nothing to resume in or fork into.
          cwd: team.location?.kind === "attached" ? team.location.cwd : null,
        },
        roles: roleChoiceView(
          membersOf(ws, team.id).flatMap((member) => (member.team ? [member.team.role] : [])),
        ),
        defaultAgentType: defaultType,
        defaultYolo: getSettings()?.defaultYolo ?? false,
        remoteEnabled: getSettings()?.remoteAgents === true,
        repo: null,
        suggestedPath: "",
        suggestedBranch: "",
      });
      return;
    }
    // Offer the worktree location only when the workspace cwd is a git repo.
    const info = await inspectRepo(ws.cwd).catch(() => null);
    const repo = info?.isRepo ? { cwd: ws.cwd, branch: info.branch } : null;
    let suggestedPath = "";
    let suggestedBranch = "";
    if (repo) {
      if (ws.worktreeBaseDir) {
        // [F2]: prefill a path ONLY when the workspace has a base folder, so
        // the dialog opens on the first usable suggestion rather than onto an
        // occupied- or blocked-path error.
        const free = await firstFreeTeamWorktreeFor(
          deckRef.current.workspaces,
          ws,
          index,
        );
        if (free) {
          suggestedPath = free.path;
          suggestedBranch = free.branch;
        }
      } else {
        // No base folder → start empty (= main repo), but still suggest a
        // branch for when the user picks a path by hand.
        const s = await suggestFor(ws)(index);
        if (s) suggestedBranch = s.branch;
      }
    }
    // The workspace may have closed while repo/path IPC was in flight. Its
    // public id can already name a replacement, so only the exact lifetime is
    // allowed to open this dialog.
    if (!findWorkspaceByRef(deckRef.current.workspaces, workspace)) return;
    // A question about a directory is standing: it was asked for a create
    // this door would replace, and the person answers it first.
    if (askRef.current) return;
    setDialog({
      workspace,
      agentId: paneId(seq),
      index,
      // Named the way the deck would name it unasked, so the field opens
      // filled and a person who does not care presses Create.
      target: {
        kind: "new-team",
        suggestedName: autoTeamName(nextTeamSeq(deckRef.current.workspaces)),
      },
      // A new team holds nothing yet: the picker opens on the lead.
      roles: roleChoiceView([]),
      defaultAgentType: defaultType,
      defaultYolo: getSettings()?.defaultYolo ?? false,
      remoteEnabled: getSettings()?.remoteAgents === true,
      repo,
      suggestedPath,
      suggestedBranch,
    });
  };

  /** Which notice a refused door reports through — the one presentation
   * decision left here: the owner says WHICH door refused and in what
   * words; the surface says where that is heard. */
  const notice = (door: DoorName, message: string) => {
    switch (door) {
      case "team":
        notices.onTeamFailed(message);
        return;
      case "member":
        notices.onCreateFailed(message);
        return;
      case "resume":
        notices.onResumeFailed(message);
        return;
      case "fork":
        notices.onForkFailed(message);
        return;
      default: {
        const unhandled: never = door;
        throw new Error(`unhandled door: ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /** Show a door's answer: nothing for done, a notice for a refusal, and
   * the standing question for a directory another team works in — whose
   * answer re-issues the owner's own create and shows THAT answer. */
  const show = (outcome: DoorOutcome): void => {
    switch (outcome.kind) {
      case "done":
        return;
      case "refused":
        notice(outcome.door, outcome.message);
        return;
      case "ask-shared":
        setSharedAsk({
          holder: outcome.holder,
          path: outcome.path,
          confirm: () => {
            setSharedAsk(null);
            show(outcome.anyway());
          },
          cancel: () => setSharedAsk(null),
        });
        return;
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled door outcome: ${JSON.stringify(unhandled)}`);
      }
    }
  };

  const confirm = (result: AgentDialogResult) => {
    const dlg = dialog;
    if (!dlg) return;
    // Closed first, whatever the door answers: a refusal is a notice and a
    // question is its own dialog, and neither stacks on top of this one.
    setDialog(null);
    void agentDoors
      .confirm({
        workspace: dlg.workspace,
        agentId: dlg.agentId,
        index: dlg.index,
        target: dlg.target,
        result,
      })
      .then(show, (error: unknown) =>
        // The owner answers refusals as outcomes; a throw is a defect on its
        // side. Heard rather than swallowed — the dialog is already closed,
        // and an unhandled rejection is silence to the person.
        notice(dlg.target.kind === "new-team" ? "team" : "member", describeError(error)),
      );
  };

  /**
   * The next suggested location not held by an open pane (nor blocked on
   * disk) — the dialog's "Use next available" action for an occupied or
   * blocked path. Suggests inside the workspace base folder when set, else
   * right next to the unusable path; null when neither gives a base (or
   * suggestions fail).
   */
  const nextFree = async (currentPath: string) => {
    const dlg = dialog;
    if (!dlg) return null;
    const currentDeck = deckRef.current;
    const ws = findWorkspaceByRef(currentDeck.workspaces, dlg.workspace);
    if (!ws) return null;
    const base = ws.worktreeBaseDir ?? parentDir(currentPath);
    if (!base) return null;
    const free = await firstFreeTeamWorktree(
      currentDeck.workspaces,
      base,
      suggestFor(ws),
      dlg.index,
      probeFor,
    );
    return findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace)
      ? free
      : null;
  };

  /**
   * The branch a worktree path implies — the dialog's live branch suggestion,
   * so the branch follows the worktree name until the user edits it. The
   * canonical branch when the folder matches this workspace's own naming
   * (`kd-<ws>-<n>` ↔ `kd/<ws>/<n>` — matched via the suggest IPC, the single
   * source of the scheme, not a TS re-implementation), else the folder name
   * verbatim (the backend sanitizes an explicit branch at create time). Null
   * when the path yields no usable name.
   */
  const branchFor = async (path: string): Promise<string | null> => {
    const dlg = dialog;
    if (!dlg) return null;
    const ws = findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace);
    if (!ws) return null;
    const folder = baseName(path);
    if (!folder) return null;
    const tail = /-(\d+)$/.exec(folder);
    if (tail) {
      const s = await suggestFor(ws)(Number(tail[1]));
      if (!findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace))
        return null;
      if (s?.folder === folder) return s.branch;
    }
    return folder;
  };

  /**
   * The "Start from" picker's paged option source: one agent's sessions from
   * the search index, newest first (an empty query) or content/title-matched
   * (FTS — the same engine as the global browser). The dialog drives paging
   * through the shared engine ([[usePagedSessionSearch]]); this maps one page
   * of hits into pick rows and forwards the full match count.
   */
  const searchSessions = async (
    agent: AgentType,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<SessionPickRow>> => {
    const page = await indexSearch(query, limit, offset, agent);
    return {
      rows: page.hits.map((hit) => ({
        handle: handleFromHit(hit),
        mtime: hit.mtime,
      })),
      total: page.total,
    };
  };

  /** How a session is already held by a pane: running behind a live PTY,
   * stopped (idle — restored, parked or suspended), or not at all — the picker
   * dims claimed rows for resume with the honest wording. */
  const sessionClaim = (sessionId: string): "running" | "stopped" | null =>
    sessionClaimant(
      deckRef.current.workspaces,
      sessionId,
      (paneId) => paneId in blockedPanes,
    )?.reads ?? null;

  /**
   * What the deck says about a candidate directory for THIS dialog — the
   * location field's one deck question, owned here beside every other one
   * (`nextFree`, `branchFor`, `sessionClaim`) rather than assembled in JSX
   * from a workspace a view would have to guess at.
   */
  const directoryAt = (path: string): DirectoryState => {
    const dlg = dialog;
    if (!dlg) return "free";
    const workspaces = deckRef.current.workspaces;
    const ws = findWorkspaceByRef(workspaces, dlg.workspace);
    return ws ? directoryState(workspaces, ws, path) : "free";
  };

  const cancel = () => setDialog(null);

  return {
    dialog,
    sharedAsk,
    directoryAt,
    openFor,
    confirm,
    cancel,
    nextFree,
    branchFor,
    searchSessions,
    sessionClaim,
  };
}
