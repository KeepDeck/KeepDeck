import { useCallback, useRef, useState } from "react";
import {
  agentSupportsYolo,
  dialogStartingYolo,
  presetPick,
  type AgentDialogResult,
  type AgentDialogTarget,
  type AgentInfo,
  type AgentType,
  type DirectoryState,
  type SessionPickRow,
  type SessionPreset,
} from "../domain/agents";
import { log } from "../ipc/log";
import {
  baseName,
  findTeam,
  findWorkspace,
  findWorkspaceByRef,
  nextAutoTeamName,
  normalizePath,
  paneSessionHandle,
  sessionClaimant,
  type DirectoryHolder,
  type SessionClaimKey,
  teamOfPane,
  type Workspace,
} from "../domain/deck";
import { handleFromHit, recordedYolo } from "../domain/journal";
import { directoryStateOf } from "../presentation/agentLocationView";
import { rolesOnTeam } from "../domain/mail";

import { indexSearch } from "../ipc/history";
import { claimsOn, locationFor } from "../ipc/lifecycle";
import type { Page } from "./usePagedSessionSearch";
import { inspectRepo } from "../ipc/worktree";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { getSettings } from "./settingsManager";
import { nextAgentType, nextYolo } from "./newAgentDefaults";
import type {
  AgentDoors,
  ContinueRequest,
  DoorName,
  DoorOutcome,
} from "./agentDoors";
import { roleChoiceView, type RoleChoice } from "../presentation/roleChoiceView";
import type { Deck } from "./useDeck";
import { errorMessage } from "@keepdeck/plugin-api";

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

/** The deck as the dialog reads it: the workspaces its suggestions and its
 * checks are taken against. Everything the dialog CHANGES goes through the
 * doors, so the deck's actions are not its to hold. */
export type AgentDialogDeck = Pick<Deck, "workspaces"> & {
  /** What the picker learns about a found session: how it ran. */
  journal: Pick<Deck["journal"], "records">;
};

/** What the dialog is opened FOR, as the caller says it: a new team, or a
 * member of the team `teamId`. */
export type AgentDialogOpening =
  | { kind: "new-team" }
  /** `session`: a recorded session the dialog opens already picked — a
   * busy or stalled card forking its own, the role still to choose. */
  | { kind: "member"; teamId: string; session?: SessionPreset };


/** Everything the agent dialog ("+ Team" / "Add member") needs to render,
 * captured at open time. */
export interface AgentDialogSpec {
  workspace: WorkspaceRef;
  /** What the dialog is for — a new team with a suggested name, or a member
   * of a team that exists, named so the title can say so. */
  target: AgentDialogTarget;
  /** The role picker's data, built against what the target team holds —
   * the view decides nothing about roles itself. */
  roles: RoleChoice;
  /** The agent the picker opens on — null when there is none to offer (the
   * catalog loading, or no agent plugin installed): the dialog says so. */
  defaultAgentType: AgentType | null;
  /** A session the dialog opens with, already picked. */
  preset?: SessionPreset;
  /** The global YOLO preference ([F6]): where the toggle starts for a fresh
   * session; a continued one starts as it ran ([`dialogStartingYolo`]). */
  defaultYolo: boolean;
  /** Whether the Experimental “Remote agents” setting is on — gates the
   *  dialog's "Where: Remote" option regardless of an agent's capability. */
  remoteEnabled: boolean;
  /** The workspace repo when its cwd is a git repo — enables the worktree
   * location field; null → the agent just runs in the workspace cwd. */
  repo: { cwd: string; branch: string | null } | null;
  /** Prefilled worktree path — the machine's next free place, which it has
   * only when the workspace has a base folder ([F2]: suggest one only then). */
  suggestedPath: string;
  /** Prefilled branch for a new worktree — that place's. */
  suggestedBranch: string;
}

/** Who a dialog's log lines are about: the team a member joins, or the
 * workspace a team is made in — the agent's id is the machine's, after. */
const dialogTag = (spec: AgentDialogSpec) => (spec.target.kind === "member" ? spec.target.teamId : spec.workspace.id);

/** The machine's next free place for a new team's worktree in `wsId`, IPC
 * failures flattened to none. */
const nextPlace = (wsId: string) => locationFor(wsId, null).then((location) => location.place, () => null);

/**
 * The agent dialog's presentation: opens it with per-workspace suggestions,
 * hands a confirmed result to the doors (`agentDoors` — what a confirmed
 * dialog DOES lives there, with its landings and its refusal words), and
 * shows the answer — a notice for a refusal, a standing question for a
 * directory another team works in. What this hook holds is UI state and the
 * form's data sources; it decides nothing about teams, roles or landings.
 */
export function useAgentDialog(
  deck: AgentDialogDeck,
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
  /** Where a confirmed dialog goes — the "+ Team" and "Add member" doors. */
  agentDoors: AgentDoors,
) {
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

  const openFor = async (ws: Workspace, opening: AgentDialogOpening = { kind: "new-team" }) => {
    const workspace = { id: ws.id, instance: ws.instance };
    const defaultType = nextAgentType(agents, ws);
    if (opening.kind === "member") {
      // A member runs in its team's directory: nothing to inspect, no
      // location to suggest — the dialog asks for the agent and nothing
      // about where. A team gone by the time the door is pressed opens no
      // dialog at all.
      const team = findTeam(ws, opening.teamId);
      if (!team) return;
      const spec: AgentDialogSpec = {
        workspace,
        target: {
          kind: "member",
          teamId: team.id,
          teamName: team.name,
          // Null while the create is out: nothing to resume in or fork into.
          cwd: team.location?.kind === "attached" ? team.location.cwd : null,
        },
        roles: roleChoiceView(rolesOnTeam(ws, team.id)),
        // A preset session is one agent's: the dialog opens on that agent.
        defaultAgentType: opening.session?.handle.agent ?? defaultType,
        ...(opening.session && { preset: opening.session }),
        defaultYolo: nextYolo(),
        remoteEnabled: getSettings()?.remoteAgents === true,
        repo: null,
        suggestedPath: "",
        suggestedBranch: "",
      };
      // The first line of the dialog's YOLO trail: where the toggle starts
      // and what put it there. The person's flips and the confirm continue
      // it, so a member that came up without the YOLO its person saw can be
      // traced step by step (task-576). Asked the way the dialog itself
      // will ask it, so the line cannot claim a start the toggle does not
      // show.
      const pick = opening.session ? presetPick(opening.session) : null;
      const starts = dialogStartingYolo(spec.defaultYolo, opening.session?.mode ?? "new", pick);
      log.info(
        "web:agents",
        `${dialogTag(spec)}: member dialog opened — YOLO starts ${starts ? "on" : "off"}, ` +
          (pick?.ranYolo === undefined ? "the global default" : "as its source session ran"),
      );
      setDialog(spec);
      return;
    }
    // Offer the worktree location only when the workspace cwd is a git repo.
    const info = await inspectRepo(ws.cwd).catch(() => null);
    const repo = info?.isRepo ? { cwd: ws.cwd, branch: info.branch } : null;
    // [F2]: prefill a path ONLY when the workspace has a base folder — the
    // machine's next free place, so the dialog opens on a usable suggestion
    // rather than onto an occupied- or blocked-path error. Without one it
    // opens empty (= main repo).
    const place = repo && ws.worktreeBaseDir ? await nextPlace(ws.id) : null;
    // The workspace may have closed while repo/path IPC was in flight. Its
    // public id can already name a replacement, so only the exact lifetime is
    // allowed to open this dialog.
    const live = findWorkspaceByRef(deckRef.current.workspaces, workspace);
    if (!live) return;
    // A question about a directory is standing: it was asked for a create
    // this door would replace, and the person answers it first.
    if (askRef.current) return;
    setDialog({
      workspace,
      // Named the way the deck would name it unasked, so the field opens
      // filled and a person who does not care presses Create.
      target: {
        kind: "new-team",
        suggestedName: nextAutoTeamName(live),
      },
      // "+ Team" lands no agent, so it shows no picker; a team with nobody
      // on it is what the data describes.
      roles: roleChoiceView([]),
      defaultAgentType: defaultType,
      defaultYolo: nextYolo(),
      remoteEnabled: getSettings()?.remoteAgents === true,
      repo,
      suggestedPath: place?.path ?? "",
      suggestedBranch: place?.branch ?? "",
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
   * answer issues the owner's own create and shows THAT answer. */
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
            void outcome.anyway().then(show, (error: unknown) => notice("team", errorMessage(error)));
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
    // What the dialog asked for, in the log: the agent, and the YOLO it sent
    // beside whether that agent can take one at all — an agent that started
    // without the YOLO the person meant can then be traced to the toggle or
    // to the agent (task-576). "+ Team" lands no agent, whatever its hidden
    // picker holds, so it has no YOLO to report. A continued session is
    // named: the toggle starts as that session ran, which no flip shows.
    const landed = dlg.target.kind === "member" ? result.agentType : null;
    const yolo = landed === null
      ? "n/a"
      : result.yolo
        ? "on"
        : agentSupportsYolo(agents, landed) ? "off" : "off (the agent declares no YOLO)";
    const continued = landed !== null && result.session
      ? `, ${result.session.mode} of ${result.session.handle.sessionId}`
      : "";
    log.info("web:agents", `${dialogTag(dlg)}: ${dlg.target.kind} dialog confirmed — ${landed ?? "no agent"}${continued}, YOLO ${yolo}`);
    // Closed first, whatever the door answers: a refusal is a notice and a
    // question is its own dialog, and neither stacks on top of this one.
    setDialog(null);
    void agentDoors
      .confirm({ workspace: dlg.workspace, target: dlg.target, result })
      .then(show, (error: unknown) =>
        // The owner answers refusals as outcomes; a throw is a defect on its
        // side. Heard rather than swallowed — the dialog is already closed,
        // and an unhandled rejection is silence to the person.
        notice(dlg.target.kind === "new-team" ? "team" : "member", errorMessage(error)),
      );
  };

  /**
   * The machine's next free place — the dialog's "Use next available"
   * action for an occupied or blocked path: not held by a team, a create or
   * a cleanup, nor taken on disk. Null when the machine has none to offer
   * (no base folder, or the IPC failed).
   */
  const nextFree = async () => {
    const dlg = dialog;
    if (!dlg || !findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace)) return null;
    const place = await nextPlace(dlg.workspace.id);
    return findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace) ? place : null;
  };

  /**
   * The branch a worktree path implies — the dialog's live branch suggestion,
   * so the branch follows the worktree name until the user edits it. The
   * machine's own branch for the folder it suggested (its naming scheme is
   * its own, not re-spelled here), else the folder name verbatim (the backend
   * sanitizes an explicit branch at create time). Null when the path yields
   * no usable name.
   */
  const branchFor = async (path: string): Promise<string | null> => {
    const dlg = dialog;
    if (!dlg) return null;
    const folder = baseName(path);
    if (!folder) return null;
    return dlg.suggestedPath && baseName(dlg.suggestedPath) === folder ? dlg.suggestedBranch : folder;
  };

  /**
   * The "Start from" picker's paged option source: one agent's sessions from
   * the search index, newest first (an empty query) or content/title-matched
   * (FTS — the same engine as the global browser). The dialog drives paging
   * through the shared engine ([[usePagedSessionSearch]]); this maps one page
   * of hits into pick rows and forwards the full match count.
   *
   * The index knows nothing of how a session ran; the journal does, for the
   * sessions KeepDeck ran in any workspace, the dialog's own asked first.
   * That is what a continuation's YOLO starts from.
   */
  const searchSessions = async (
    agent: AgentType,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<SessionPickRow>> => {
    const page = await indexSearch(query, limit, offset, agent);
    const journal = deckRef.current.journal.records;
    return {
      rows: page.hits.map((hit) => {
        const handle = handleFromHit(hit);
        const ranYolo = dialog ? recordedYolo(journal, handle, dialog.workspace.id) : undefined;
        return { handle, mtime: hit.mtime, ...(ranYolo !== undefined && { ranYolo }) };
      }),
      total: page.total,
    };
  };

  /** How a session is already held by a pane: running behind a live PTY,
   * stopped (idle — restored, parked or suspended), or not at all — the picker
   * dims claimed rows for resume with the honest wording. */
  // Stable across the app's renders (the deck is read through its ref):
  // the picker memoizes its rows on it.
  const sessionClaim = useCallback(
    (session: SessionClaimKey): "running" | "stopped" | null =>
      sessionClaimant(
        deckRef.current.workspaces,
        session,
        (paneId) => paneId in blockedPanes,
      )?.reads ?? null,
    [blockedPanes],
  );

  /**
   * What the lifecycle says holds a candidate directory — the location
   * field's one question about who is there, owned here beside every other
   * one (`nextFree`, `branchFor`, `sessionClaim`) rather than assembled in
   * a view.
   */
  const directoryAt = async (path: string): Promise<DirectoryState> => directoryStateOf(await claimsOn(normalizePath(path)));

  const cancel = () => setDialog(null);

  /** The person flipped the dialog's YOLO toggle: a step of the trail its
   * opening starts and its confirm ends (task-576). */
  const yoloToggled = (on: boolean) => {
    if (!dialog) return;
    log.info("web:agents", `${dialogTag(dialog)}: YOLO toggled ${on ? "on" : "off"} in the dialog`);
  };

  /** A busy or stalled card's Fork: the member dialog for the pane's team,
   * its bound session already picked to fork — the role still the person's
   * to choose. A pane on no team, or with nothing bound, has nothing to
   * open it for. */
  const forkPaneSession = (wsId: string, paneId: string) => {
    const ws = findWorkspace(deckRef.current.workspaces, wsId);
    const pane = ws?.panes.find((candidate) => candidate.id === paneId);
    if (!ws || !pane) return;
    const team = teamOfPane(ws, pane);
    const handle = paneSessionHandle(ws, pane);
    if (!team || !handle) return;
    void openFor(ws, { kind: "member", teamId: team.id, session: { mode: "fork", handle } });
  };

  /** The empty team's sessions list: a recorded session continued onto the
   * team under the role picked there — the member door without its dialog,
   * its answer shown the same way. */
  const continueSession = (
    ws: Workspace,
    teamId: string,
    session: ContinueRequest["session"],
    role: string,
  ) => {
    void agentDoors
      .continueSession({ workspace: { id: ws.id, instance: ws.instance }, teamId, session, role })
      .then(show, (error: unknown) => notice(session.mode, errorMessage(error)));
  };

  return {
    dialog,
    sharedAsk,
    directoryAt,
    openFor,
    confirm,
    cancel,
    yoloToggled,
    continueSession,
    forkPaneSession,
    nextFree,
    branchFor,
    searchSessions,
    sessionClaim,
  };
}
