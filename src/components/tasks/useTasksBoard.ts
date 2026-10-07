import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TasksAccess } from "../../app/tasks/tasksFeature";
import { useTasksBoardFeed } from "./useBoardState";
import { artifactChanges } from "../../app/artifacts/changes";
import { openArtifactByRef } from "../../app/artifacts/entryPoints";
import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";
import { describeError } from "../../ipc/log";
import { isTypingTarget } from "../../ui/typingTarget";
import { refusalOf, tasksEnableStatus } from "../../app/tasks/enableStatus";
import { readyBoard } from "../../app/tasks/tasksService";
import { getSettings, updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { DEFAULT_SETTINGS, type TasksBoardSettings } from "../../domain/settings";
import { refusalText } from "../../app/tasks/refusalText";
import { teamsOf, type Workspace } from "../../domain/deck";
import {
  USER_ACTOR,
  addLabel,
  attachArtifact,
  blockerLink,
  detachArtifact,
  removeBlocker,
  type BlockerSide,
  findTask,
  reachableStatuses,
  removeLabel,
  tasksOfTeam,
  type CreateTaskInput,
  type TaskChange,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import {
  IDLE,
  armRow,
  assigneeOf,
  pickedOrNone,
  boardFolded,
  boardFoldedEpics,
  boardWithEpicFold,
  boardWithFold,
  rowInFlight,
  dragOutlived,
  taskOnScreen,
  escapeDrag,
  listView,
  rowStepOf,
  stepRow,
  clickDisbelieved,
  initialScreen,
  moveRow,
  newTaskFormView,
  releaseRow,
  screenReducer,
  taskDetailView,
  tasksLadder,
  teamOnScreen,
  boardBanner,
  restoreConfirm,
  restoreView,
  queryToolbarView,
  findsNothing,
  queryOn,
  walksRows,
  wideView,
  type ArtifactRef,
  type RowGrip,
  type DragState,
  type ScreenAction,
} from "../../presentation/tasks";

export type { TasksAccess } from "../../app/tasks/tasksFeature";

export type { RowGrip } from "../../presentation/tasks";



/**
 * The dialog's machine: which team, what is selected, the form,
 * and every write — all through the owner, all as the USER. The
 * components render what this hands them and decide nothing.
 *
 * `focus`/`onFocus` are the modal router's: a notification opens the
 * dialog on a task through the same seam a click selects one.
 */
export function useTasksBoard(
  access: TasksAccess,
  workspace: Workspace | null,
  /** The stage's open team as the dialog mounts — the screen's first
   * choice; later values are not read. */
  stageTeam: string | null,
  focus: string | null,
  onFocus: (taskId: string | null) => void,
  /** The dialog's own close — what an Escape with nothing left to peel does. */
  onClose: () => void,
  now: number,
  /** The artifacts registry as this surface may read it — for the open
   * task's attachments. Bound once at the composition root. */
  artifactReads: ArtifactsRegistryReadPort,
) {
  const workspaceId = workspace?.id ?? null;
  const { service, revision, state } = useTasksBoardFeed(access, workspaceId);
  const enableRefusal = refusalOf(
    useSyncExternalStore(tasksEnableStatus.subscribe, tasksEnableStatus.last, tasksEnableStatus.last),
  );
  const teams = workspace ? teamsOf(workspace) : [];
  // The screen's state is ONE value and every transition is the
  // presentation machine's; this hook applies what it answers. A ref
  // mirrors it so a sequence of actions within one event sees its own
  // effects, and no decision runs inside a React updater.
  const [screen, setScreen] = useState(() => initialScreen(stageTeam));
  const screenRef = useRef(screen);
  // The team the board resolved on the last render — what the person was
  // looking at when they acted, and what the machine pins as their choice.
  const teamIdRef = useRef<string | null>(null);
  const run = useCallback(
    (action: ScreenAction) => {
      const outcome = screenReducer(screenRef.current, action, teamIdRef.current);
      screenRef.current = outcome.state;
      setScreen(outcome.state);
      if (outcome.focus !== undefined) onFocus(outcome.focus);
      if (outcome.closeDialog) onClose();
      return outcome;
    },
    [onFocus, onClose],
  );
  const { chosenTeam, composing, hover } = screen;
  /** The way out an unusable database offers, or null. */
  const offer = restoreView(service?.recovery() ?? null, now);
  /** The workspace's artifacts, for the open task's attachments. Read
   * when a task is open and re-read when the registry changes; empty
   * (never an error) when the artifacts feature is off. */
  const [artifacts, setArtifacts] = useState<{ ws: string; list: ArtifactRef[] } | null>(null);
  const artifactRevision = useSyncExternalStore(
    artifactChanges.subscribe,
    artifactChanges.revision,
    artifactChanges.revision,
  );
  useEffect(() => {
    if (workspaceId === null || focus === null) return;
    let live = true;
    void artifactReads
      .list({ workspaceId })
      .then((rows) => {
        if (live) setArtifacts({ ws: workspaceId, list: rows.map((row) => ({ id: row.id, title: row.title })) });
      })
      .catch(() => {
        if (live) setArtifacts({ ws: workspaceId, list: [] });
      });
    return () => {
      live = false;
    };
  }, [artifactReads, workspaceId, focus, artifactRevision]);
  const knownArtifacts = artifacts !== null && artifacts.ws === workspaceId ? artifacts.list : [];
  // Pointer events, not HTML5 drag: the webview hands the deck no native
  // drags (the OS drop router owns them), so a row is dragged the way a
  // pane is. What a press, a move and a release DO is the presentation
  // machine's (`rowDrag`); this hook feeds it pointer facts. The ref is
  // the state read by handlers — never a React updater, which StrictMode
  // runs twice and which must not perform IO.
  const [drag, setDrag] = useState<DragState>(IDLE);
  const dragRef = useRef<DragState>(IDLE);
  const updateDrag = (next: DragState) => {
    dragRef.current = next;
    setDrag(next);
  };
  const dragEndedAt = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A copy on its way: the ref answers a second press at once, the state
  // shows the Duplicate control as busy.
  const duplicating = useRef(false);
  const [copying, setCopying] = useState(false);
  // The board's posture — the list's folds, of groups and of epics — is a setting, kept across
  // openings and launches (user); every change reads the latest stored
  // posture, so a change that lands later never writes back a stale one.
  const posture = (useSettings() ?? DEFAULT_SETTINGS).tasksBoard;
  const folded = useMemo(() => boardFolded(posture), [posture]);
  const foldedEpics = useMemo(() => boardFoldedEpics(posture), [posture]);
  // The person's folds, of groups and of epics, as ONE token: the list
  // eases a change of it, and only that (VirtualList easeKey).
  const folds = useMemo(() => ({ groups: folded, epics: foldedEpics }), [folded, foldedEpics]);
  const keepPosture = (change: (stored: TasksBoardSettings) => TasksBoardSettings | null) => {
    const next = change((getSettings() ?? DEFAULT_SETTINGS).tasksBoard);
    if (next !== null) updateSettings({ tasksBoard: next });
  };

  const board = readyBoard(state);
  const unsaved = boardBanner({
    unsaved: state?.kind === "ready" ? state.unsaved : null,
    readOnly: service?.readOnly() ?? null,
  });
  // The team on screen follows the task the dialog is on, then the choice.
  const focusedTask = board && focus !== null ? (findTask(board, focus) ?? null) : null;
  const teamId = teamOnScreen(
    teams.map((team) => team.id),
    chosenTeam,
    focusedTask?.teamId ?? null,
  );
  teamIdRef.current = teamId;
  const query = queryOn(screen, teamId);
  const teamTasks = useMemo(
    () => (board && teamId !== null ? tasksOfTeam(board, teamId) : []),
    [board, teamId],
  );
  const roster = useMemo(
    () => (service && workspaceId !== null && teamId !== null ? service.rosterOf(workspaceId, teamId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, teamId, revision],
  );

  // The drag's window listeners live only while a row is pressed or in
  // flight; they read the board and the roster, so they come after both.
  useEffect(() => {
    if (drag.kind === "idle") return;
    const targetsOf = (id: string) => {
      const task = taskOnScreen(board, id, teamId);
      return board && task ? new Set(reachableStatuses(task, USER_ACTOR, { board, roster, at: now })) : null;
    };
    const onMove = (event: PointerEvent) => updateDrag(moveRow(dragRef.current, event.clientX, event.clientY, targetsOf));
    // A release anywhere ends the drag; a group's own release handler
    // (the drop) runs first, in the bubble phase before the window's.
    const onUp = () => release(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag.kind, board, roster, now, teamId]);

  const ladder = tasksLadder({
    workspaceId,
    hasTeam: teamId !== null,
    ownerUp: service !== null,
    enableRefusal,
    state,
    taskCount: teamTasks.length,
  });

  const open = taskOnScreen(board, focus, teamId);
  const detail = open ? taskDetailView(open, board!, roster, now, knownArtifacts, screen.activityOpen, teams) : null;
  // Stable by identity between renders that change nothing it shows: the
  // windowed list anchors the reader's place on a CHANGE of its items, and
  // a fresh array per pointer move re-ran that on every one.
  const openId = detail?.id ?? null;
  const listItems = useMemo(
    () => (board ? listView(teamTasks, board, now, query, folded, openId, foldedEpics) : []),
    [board, teamTasks, now, query, folded, openId, foldedEpics],
  );
  const filters = queryToolbarView(query);
  const nothingFound = findsNothing(teamTasks, query);
  const inFlight = rowInFlight(drag, board, teamId, now);
  // The task in flight left the board on screen: the drag has nothing to drop.
  useEffect(() => {
    const ended = dragOutlived(dragRef.current, inFlight);
    if (ended === null) return;
    updateDrag(ended);
    run({ type: "hover", status: null, dragging: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight]);

  // J / K walk the list's rows, the open task following — never while a
  // field has the keys (a comment, a label being typed).
  const walks = walksRows(screen);
  useEffect(() => {
    if (!walks) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const step = rowStepOf({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        inField: isTypingTarget(event.target),
      });
      if (step === null) return;
      const next = stepRow(listItems, openId, step);
      if (next === null) return;
      event.preventDefault();
      run({ type: "row", id: next, open: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walks, listItems, openId]);
  const form = newTaskFormView(roster, board, teamId, screen.composeEpic);

  /** The pointer was released over `over` (a status group, or nothing). One
   * release is one outcome: decided from the ref, applied once, here. */
  const release = (over: TaskStatus | null) => {
    const outcome = releaseRow(dragRef.current, over);
    updateDrag(outcome.state);
    if (outcome.dragged) dragEndedAt.current = Date.now();
    const move = outcome.move;
    if (move) {
      // The group it goes into keeps its fold: the person's own act, never
      // a drop's (user) — a folded one counts the task in its heading.
      void apply(move.id, [{ kind: "status", to: move.to }]);
    }
    run({ type: "hover", status: null, dragging: false });
  };

  const write = useCallback(
    async (work: () => Promise<{ ok: boolean; refusal?: unknown } & Record<string, unknown>>) => {
      const result = await work();
      if (result.ok) {
        setError(null);
        return true;
      }
      setError(refusalText(result.refusal as never));
      return false;
    },
    [],
  );

  /** A change through the owner as the user; whether it was accepted. */
  const apply = useCallback(
    (taskId: string, changes: TaskChange[]): Promise<boolean> => {
      if (!service || workspaceId === null) return Promise.resolve(false);
      return write(() => service.apply(workspaceId, taskId, changes, USER_ACTOR));
    },
    [service, workspaceId, write],
  );

  return {
    ladder,
    teams: teams.map((team) => ({ id: team.id, name: team.name })),
    teamId,
    selectTeam: (id: string) => run({ type: "team", id }),
    detail,
    /** A row was clicked: opened, or put away when it was the open one. */
    select: (taskId: string) => {
      // The click that follows a drop is the same press that dragged.
      if (clickDisbelieved(dragEndedAt.current, Date.now())) return;
      run({ type: "row", id: taskId, open: focus });
    },
    close: () => run({ type: "close" }),
    escape: () => {
      const putBack = escapeDrag(dragRef.current);
      if (putBack === null) return run({ type: "escape", detailOpen: detail !== null });
      updateDrag(putBack);
      // The release that follows is the same press: its click opens nothing.
      dragEndedAt.current = Date.now();
      run({ type: "hover", status: null, dragging: false });
    },
    drag,
    inFlight,
    hover,
    /** A row was pressed: it becomes a drag once the pointer travels. */
    armDrag: (taskId: string, x: number, y: number, grip: RowGrip) => updateDrag(armRow(taskId, x, y, grip)),
    /** The pointer is over a status group, or over none. */
    hoverGroup: (status: TaskStatus | null) => run({ type: "hover", status, dragging: dragRef.current.kind === "dragging" }),
    /** Released over a status group. */
    dropOn: release,
    listItems,
    fold: (status: TaskStatus) => keepPosture((stored) => boardWithFold(stored, status)),
    foldEpic: (uid: string) => keepPosture((stored) => boardWithEpicFold(stored, uid)),
    folds,
    filters,
    nothingFound,
    /** A label clicked on a row narrows the view to it; clicking the one
     * that already does, or clearing its chip, widens it again. */
    pickLabel: (label: string | null) => run({ type: "label", label }),
    composing,
    compose: () => run({ type: "compose" }),
    /** The form, opened in an epic: the epic picked for the new task. */
    composeIn: (epicId: string) => run({ type: "compose", epic: epicId }),
    /** Put a task under the epic a pick names, or under none. */
    setParent: (taskId: string, picked: string) => void apply(taskId, [{ kind: "parent", to: pickedOrNone(picked) }]),
    cancelCompose: () => run({ type: "cancelCompose" }),
    toggleCompose: () => run({ type: "toggleCompose" }),
    wide: wideView(screen, detail !== null),
    toggleWide: () => run({ type: "toggleWide", detailOpen: detail !== null }),
    toggleActivity: () => run({ type: "toggleActivity" }),
    narrow: () => run({ type: "narrow" }),
    form,
    error,
    unsaved,
    /** The way out an unusable database offers, or null. */
    restore: offer,
    /** Its confirm, while it is asked about. */
    restoreConfirm: restoreConfirm(screen, offer),
    askRestore: () => run({ type: "askRestore" }),
    cancelRestore: () => run({ type: "cancelRestore" }),
    /** The person confirmed it: their choice takes the database's place. */
    confirmRestore: () => {
      if (!run({ type: "confirmRestore" }).restore || !service || !offer) return;
      void service.restore(offer.choice).then(() => setError(null), (e: unknown) => setError(describeError(e)));
    },
    move: (taskId: string, to: TaskStatus) => void apply(taskId, [{ kind: "status", to }]),
    assign: (taskId: string, assignee: string) => void apply(taskId, [{ kind: "assign", assignee: assigneeOf(assignee) }]),
    setPriority: (taskId: string, to: TaskPriority) => void apply(taskId, [{ kind: "priority", to }]),
    rename: (taskId: string, title: string): Promise<boolean> => apply(taskId, [{ kind: "title", to: title }]),
    comment: (taskId: string, body: string) => apply(taskId, [{ kind: "comment", body }]),
    attachArtifact: (taskId: string, slug: string) => {
      const task = board ? findTask(board, taskId) : undefined;
      if (!task) return;
      void apply(taskId, [attachArtifact(task, slug)]);
    },
    /** Link two tasks by a blocker link, `side` as the first stands on it:
     * the change goes to whichever of them waits (`blockerLink`). */
    link: (taskId: string, otherId: string, side: BlockerSide) => {
      const task = board ? findTask(board, taskId) : undefined;
      const other = board ? findTask(board, otherId) : undefined;
      if (!task || !other) return;
      const { taskId: waiting, change } = blockerLink(task, other, side);
      void apply(waiting, [change]);
    },
    unblock: (taskId: string, blockerId: string) => void apply(taskId, [removeBlocker(blockerId)]),
    /** Resolves to whether the label landed; the field clears only then. */
    addLabel: (taskId: string, label: string): Promise<boolean> => apply(taskId, [addLabel(label)]),
    removeLabel: (taskId: string, label: string) => void apply(taskId, [removeLabel(label)]),
    detachArtifact: (taskId: string, slug: string) => {
      const task = board ? findTask(board, taskId) : undefined;
      if (!task) return;
      void apply(taskId, [detachArtifact(task, slug)]);
    },
    /** Open an attached artifact in the browser — the registry's own
     * ladder resolves the live address at the click. */
    openArtifact: (slug: string) => {
      if (workspaceId === null) return;
      void openArtifactByRef(workspaceId, slug)
        .then(() => setError(null))
        .catch((e: unknown) => setError(describeError(e)));
    },
    /** Copy a task as a fresh one and open the copy — in the panel as it
     * stands (wide stays wide). One copy per press: a second press while
     * one is on its way does nothing, since a copy cannot be taken back. */
    duplicate: (taskId: string) => {
      if (!service || workspaceId === null || duplicating.current) return;
      duplicating.current = true;
      setCopying(true);
      void write(async () => {
        const result = await service.duplicate(workspaceId, taskId, USER_ACTOR);
        if (result.ok) run({ type: "row", id: result.task.id, open: null });
        return result;
      }).finally(() => {
        duplicating.current = false;
        setCopying(false);
      });
    },
    copying,
    /** Hand a task to another team; on success it has left this board, so
     * the panel closes. */
    transfer: (taskId: string, teamId: string) => {
      if (!service || workspaceId === null) return;
      void write(async () => {
        const result = await service.transfer(workspaceId, taskId, teamId, USER_ACTOR);
        if (result.ok) run({ type: "close" });
        return result;
      });
    },
    create: async (input: Omit<CreateTaskInput, "teamId">) => {
      if (!service || workspaceId === null || teamId === null) return;
      await write(async () => {
        const result = await service.create(workspaceId, { ...input, teamId }, USER_ACTOR);
        if (result.ok) run({ type: "created", id: result.task.id });
        return result;
      });
    },
  };
}

export type TasksBoard = ReturnType<typeof useTasksBoard>;
