import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TasksAccess } from "../../app/tasks/tasksFeature";
import { useTasksBoardFeed } from "./useBoardState";
import { artifactChanges } from "../../app/artifacts/changes";
import { openArtifactByRef } from "../../app/artifacts/entryPoints";
import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";
import { describeError } from "../../ipc/log";
import { refusalOf, tasksEnableStatus } from "../../app/tasks/enableStatus";
import { refusalText } from "../../app/tasks/refusalText";
import { teamsOf, type Workspace } from "../../domain/deck";
import {
  USER_ACTOR,
  findTask,
  reachableStatuses,
  tasksOfTeam,
  type CreateTaskInput,
  type TaskChange,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import {
  IDLE,
  armCard,
  assigneeOf,
  boardView,
  clickDisbelieved,
  initialScreen,
  moveCard,
  newTaskFormView,
  queuesView,
  releaseCard,
  screenReducer,
  taskDetailView,
  tasksLadder,
  teamOnScreen,
  unsavedBanner,
  wideView,
  type ArtifactRef,
  type CardGrip,
  type DragState,
  type ScreenAction,
  type TasksMode,
} from "../../presentation/tasks";

export type { TasksAccess } from "../../app/tasks/tasksFeature";

export type { TasksMode, CardGrip } from "../../presentation/tasks";



/** A card in flight: which, what it is called, where the pointer is, and
 * the columns it may land in — judged once, when the drag began, by the
 * same table the picker reads. */


/**
 * The dialog's machine: which team and view, what is selected, the form,
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
    },
    [onFocus, onClose],
  );
  const { mode, showCancelled, chosenTeam, composing, hover } = screen;
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
  // drags (the OS drop router owns them), so a card is dragged the way a
  // pane is. What a press, a move and a release DO is the presentation
  // machine's (`cardDrag`); this hook feeds it pointer facts. The ref is
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

  const board = state?.kind === "ready" ? state.board : null;
  const unsaved = state?.kind === "ready" && state.unsaved !== null ? unsavedBanner(state.unsaved) : null;
  // The team on screen follows the task the dialog is on, then the choice.
  const focusedTask = board && focus !== null ? (findTask(board, focus) ?? null) : null;
  const teamId = teamOnScreen(
    teams.map((team) => team.id),
    chosenTeam,
    focusedTask?.teamId ?? null,
  );
  teamIdRef.current = teamId;
  const teamTasks = useMemo(
    () => (board && teamId !== null ? tasksOfTeam(board, teamId) : []),
    [board, teamId],
  );
  const roster = useMemo(
    () => (service && workspaceId !== null && teamId !== null ? service.rosterOf(workspaceId, teamId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, teamId, revision],
  );

  // The drag's window listeners live only while a card is pressed or in
  // flight; they read the board and the roster, so they come after both.
  useEffect(() => {
    if (drag.kind === "idle") return;
    const targetsOf = (id: string) => {
      const task = board ? findTask(board, id) : undefined;
      return board && task ? new Set(reachableStatuses(task, USER_ACTOR, { board, roster, at: now })) : null;
    };
    const onMove = (event: PointerEvent) => updateDrag(moveCard(dragRef.current, event.clientX, event.clientY, targetsOf));
    // A release anywhere ends the drag; a column's own release handler
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
  }, [drag.kind, board, roster, now]);

  const ladder = tasksLadder({
    workspaceId,
    hasTeam: teamId !== null,
    ownerUp: service !== null,
    enableRefusal,
    state,
    taskCount: teamTasks.length,
  });

  const selected = focusedTask;
  const detail =
    selected && selected.teamId === teamId ? taskDetailView(selected, board!, roster, now, knownArtifacts) : null;
  const columns = board ? boardView(teamTasks, board, { showCancelled, now }) : [];
  const lanes = board && teamId !== null ? queuesView(board, teamId, roster, now) : [];
  const form = newTaskFormView(roster);

  /** The pointer was released over `over` (a column, or nothing). One
   * release is one outcome: decided from the ref, applied once, here. */
  const release = (over: TaskStatus | null) => {
    const outcome = releaseCard(dragRef.current, over);
    updateDrag(outcome.state);
    if (outcome.dragged) dragEndedAt.current = Date.now();
    if (outcome.move) void apply(outcome.move.id, [{ kind: "status", to: outcome.move.to }]);
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
    mode,
    setMode: (next: TasksMode) => run({ type: "mode", mode: next }),
    teams: teams.map((team) => ({ id: team.id, name: team.name })),
    teamId,
    selectTeam: (id: string) => run({ type: "team", id }),
    showCancelled,
    toggleCancelled: () => run({ type: "toggleCancelled" }),
    columns,
    lanes,
    detail,
    /** A card was clicked: opened, or put away when it was the open one. */
    select: (taskId: string) => {
      // The click that follows a drop is the same press that dragged.
      if (clickDisbelieved(dragEndedAt.current, Date.now())) return;
      run({ type: "card", id: taskId, open: focus });
    },
    close: () => run({ type: "close" }),
    escape: () => run({ type: "escape", detailOpen: detail !== null }),
    drag,
    hover,
    /** A card was pressed: it becomes a drag once the pointer travels. */
    armDrag: (taskId: string, x: number, y: number, grip: CardGrip) => updateDrag(armCard(taskId, x, y, grip)),
    /** The pointer is over a column, or over none. */
    hoverColumn: (status: TaskStatus | null) => run({ type: "hover", status, dragging: dragRef.current.kind === "dragging" }),
    /** Released over a column. */
    dropOn: release,
    composing,
    compose: () => run({ type: "compose" }),
    cancelCompose: () => run({ type: "cancelCompose" }),
    toggleCompose: () => run({ type: "toggleCompose" }),
    wide: wideView(screen, detail !== null),
    toggleWide: () => run({ type: "toggleWide", detailOpen: detail !== null }),
    narrow: () => run({ type: "narrow" }),
    form,
    error,
    unsaved,
    move: (taskId: string, to: TaskStatus) => void apply(taskId, [{ kind: "status", to }]),
    assign: (taskId: string, assignee: string) => void apply(taskId, [{ kind: "assign", assignee: assigneeOf(assignee) }]),
    setPriority: (taskId: string, to: TaskPriority) => void apply(taskId, [{ kind: "priority", to }]),
    comment: (taskId: string, body: string) => apply(taskId, [{ kind: "comment", body }]),
    attachArtifact: (taskId: string, slug: string) => {
      const task = board ? findTask(board, taskId) : undefined;
      if (!task) return;
      void apply(taskId, [{ kind: "artifacts", to: [...task.artifacts, slug] }]);
    },
    detachArtifact: (taskId: string, slug: string) => {
      const task = board ? findTask(board, taskId) : undefined;
      if (!task) return;
      void apply(taskId, [{ kind: "artifacts", to: task.artifacts.filter((other) => other !== slug) }]);
    },
    /** Open an attached artifact in the browser — the registry's own
     * ladder resolves the live address at the click. */
    openArtifact: (slug: string) => {
      if (workspaceId === null) return;
      void openArtifactByRef(workspaceId, slug)
        .then(() => setError(null))
        .catch((e: unknown) => setError(describeError(e)));
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
