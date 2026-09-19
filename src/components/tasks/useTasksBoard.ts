import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TasksService } from "../../app/tasks";
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
  boardView,
  newTaskFormView,
  queuesView,
  taskDetailView,
  tasksLadder,
  unsavedBanner,
  type ArtifactRef,
} from "../../presentation/tasks";

/** The owner as the runtime hands it to surfaces: the current service, or
 * null while the feature is down, and the signal that it came or went. */
export interface TasksAccess {
  current(): TasksService | null;
  subscribe(listener: () => void): () => void;
}

export type TasksMode = "board" | "queues";

const noop = () => () => {};
const zero = () => 0;

/** How far a pressed card travels before it is a drag and not a click. */
const DRAG_THRESHOLD_PX = 6;
/** The click the browser fires after a release must not open the card
 * that was just dropped; this is how long it is disbelieved. */
const CLICK_AFTER_DRAG_MS = 250;

/** A card in flight: which, what it is called, where the pointer is, and
 * the columns it may land in — judged once, when the drag began, by the
 * same table the picker reads. */
/** Where the press landed on the card, and how wide the card was: the
 * ghost is drawn at exactly that size, under exactly that point. */
export interface CardGrip {
  width: number;
  offsetX: number;
  offsetY: number;
}

export interface CardDrag extends CardGrip {
  id: string;
  x: number;
  y: number;
  targets: ReadonlySet<TaskStatus>;
}

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
  focus: string | null,
  onFocus: (taskId: string | null) => void,
  now: number,
  /** The artifacts registry as this surface may read it — for the open
   * task's attachments. Bound once at the composition root. */
  artifactReads: ArtifactsRegistryReadPort,
) {
  const service = useSyncExternalStore(access.subscribe, access.current, access.current);
  const revision = useSyncExternalStore(
    service ? service.subscribe : noop,
    service ? service.revision : zero,
    service ? service.revision : zero,
  );
  const enableRefusal = refusalOf(
    useSyncExternalStore(tasksEnableStatus.subscribe, tasksEnableStatus.last, tasksEnableStatus.last),
  );
  const workspaceId = workspace?.id ?? null;
  const teams = workspace ? teamsOf(workspace) : [];
  const [chosenTeam, setChosenTeam] = useState<string | null>(null);
  // The team on screen: the one chosen, if it still exists, else the first.
  const teamId = teams.some((team) => team.id === chosenTeam) ? chosenTeam : (teams[0]?.id ?? null);
  const [mode, setMode] = useState<TasksMode>("board");
  const [showCancelled, setShowCancelled] = useState(false);
  const [folds, setFolds] = useState<ReadonlyMap<TaskStatus, boolean>>(new Map());
  const [composing, setComposing] = useState(false);
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
  /** The open task filling the stage, the board put away behind it. */
  const [wide, setWide] = useState(false);
  // Pointer events, not HTML5 drag: the webview hands the deck no native
  // drags (the OS drop router owns them), so a card is dragged the way a
  // pane is — pressed, moved past a threshold, released over a target.
  const [armed, setArmed] = useState<({ id: string; x: number; y: number } & CardGrip) | null>(null);
  const [dragging, setDragging] = useState<CardDrag | null>(null);
  const [hover, setHover] = useState<TaskStatus | null>(null);
  const dragEndedAt = useRef(0);
  const endDrag = useCallback(() => {
    setDragging((current) => {
      if (current) dragEndedAt.current = Date.now();
      return null;
    });
    setArmed(null);
    setHover(null);
  }, []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (service && workspaceId !== null) void service.ready(workspaceId);
  }, [service, workspaceId]);

  // `revision` is the board's clock: the state read below changes only
  // when it ticks, so it is the dependency even though the read itself
  // does not name it.
  const state = useMemo(
    () => (service && workspaceId !== null ? service.peek(workspaceId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, revision],
  );
  const board = state?.kind === "ready" ? state.board : null;
  const unsaved = state?.kind === "ready" && state.unsaved !== null ? unsavedBanner(state.unsaved) : null;
  const teamTasks = useMemo(
    () => (board && teamId !== null ? tasksOfTeam(board, teamId) : []),
    [board, teamId],
  );
  const roster = useMemo(
    () => (service && workspaceId !== null && teamId !== null ? service.rosterOf(workspaceId, teamId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, teamId, revision],
  );

  // The drag's window listeners live only while a card is armed or in
  // flight; they read the board and the roster, so they come after both.
  useEffect(() => {
    if (armed === null && dragging === null) return;
    const onMove = (event: PointerEvent) => {
      if (dragging) {
        setDragging({ ...dragging, x: event.clientX, y: event.clientY });
        return;
      }
      if (!armed || Math.hypot(event.clientX - armed.x, event.clientY - armed.y) < DRAG_THRESHOLD_PX) return;
      const task = board ? findTask(board, armed.id) : undefined;
      setArmed(null);
      if (!board || !task) return;
      setDragging({
        id: task.id,
        x: event.clientX,
        y: event.clientY,
        width: armed.width,
        offsetX: armed.offsetX,
        offsetY: armed.offsetY,
        targets: new Set(reachableStatuses(task, USER_ACTOR, { board, roster, at: now })),
      });
    };
    // Bubble phase, so a column's own release handler (the drop) runs first.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [armed, dragging, board, roster, now, endDrag]);

  const ladder = tasksLadder({
    workspaceId,
    hasTeam: teamId !== null,
    ownerUp: service !== null,
    enableRefusal,
    state,
    taskCount: teamTasks.length,
  });

  const selected = board && focus !== null ? (findTask(board, focus) ?? null) : null;
  const detail =
    selected && selected.teamId === teamId ? taskDetailView(selected, board!, roster, now, knownArtifacts) : null;
  const columns = board ? boardView(teamTasks, board, { showCancelled, folds, now }) : [];
  const lanes = board && teamId !== null ? queuesView(board, teamId, roster, now) : [];
  const form = newTaskFormView(roster);

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

  const apply = useCallback(
    (taskId: string, changes: TaskChange[]) => {
      if (!service || workspaceId === null) return;
      void write(() => service.apply(workspaceId, taskId, changes, USER_ACTOR));
    },
    [service, workspaceId, write],
  );

  return {
    ladder,
    mode,
    setMode,
    teams: teams.map((team) => ({ id: team.id, name: team.name })),
    teamId,
    selectTeam: (id: string) => {
      setChosenTeam(id);
      onFocus(null);
    },
    showCancelled,
    toggleCancelled: () => setShowCancelled((current) => !current),
    /** Hide or Show a closed column: the opposite of what it shows NOW,
     * whichever way it got there — a default or an earlier choice. */
    toggleColumn: (status: TaskStatus) => {
      const shown = columns.find((column) => column.status === status);
      if (!shown) return;
      setFolds((current) => new Map(current).set(status, !shown.collapsed));
    },
    columns,
    lanes,
    detail,
    /** Pick a task, or put it away: the open card pressed again closes. */
    select: (taskId: string | null) => {
      // The click that follows a drop is the same press that dragged.
      if (Date.now() - dragEndedAt.current < CLICK_AFTER_DRAG_MS) return;
      setComposing(false);
      if (taskId !== null && taskId === focus) {
        setWide(false);
        onFocus(null);
        return;
      }
      onFocus(taskId);
    },
    close: () => {
      setWide(false);
      onFocus(null);
    },
    dragging,
    hover,
    /** A card was pressed: it becomes a drag once the pointer travels. */
    armDrag: (taskId: string, x: number, y: number, grip: CardGrip) => setArmed({ id: taskId, x, y, ...grip }),
    /** The pointer is over a column, or over none. */
    hoverColumn: (status: TaskStatus | null) => {
      if (dragging) setHover(status);
    },
    /** Released over a column: the move, if that column was a target. */
    dropOn: (status: TaskStatus) => {
      if (dragging && dragging.targets.has(status)) apply(dragging.id, [{ kind: "status", to: status }]);
      endDrag();
    },
    composing,
    compose: () => {
      onFocus(null);
      setWide(false);
      setComposing(true);
    },
    cancelCompose: () => setComposing(false),
    /** Wide only while a task is open — a wide nothing is the board. */
    wide: wide && detail !== null,
    toggleWide: () => setWide((current) => !current),
    narrow: () => setWide(false),
    form,
    error,
    unsaved,
    move: (taskId: string, to: TaskStatus) => apply(taskId, [{ kind: "status", to }]),
    assign: (taskId: string, assignee: string) => apply(taskId, [{ kind: "assign", assignee: assignee === "" ? null : assignee }]),
    setPriority: (taskId: string, to: TaskPriority) => apply(taskId, [{ kind: "priority", to }]),
    comment: (taskId: string, body: string) => apply(taskId, [{ kind: "comment", body }]),
    attachArtifact: (taskId: string, slug: string) => {
      const task = board ? findTask(board, taskId) : undefined;
      if (!task) return;
      apply(taskId, [{ kind: "artifacts", to: [...task.artifacts, slug] }]);
    },
    detachArtifact: (taskId: string, slug: string) => {
      const task = board ? findTask(board, taskId) : undefined;
      if (!task) return;
      apply(taskId, [{ kind: "artifacts", to: task.artifacts.filter((other) => other !== slug) }]);
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
      const ok = await write(async () => {
        const result = await service.create(workspaceId, { ...input, teamId }, USER_ACTOR);
        if (result.ok) onFocus(result.task.id);
        return result;
      });
      if (ok) setComposing(false);
    },
  };
}

export type TasksBoard = ReturnType<typeof useTasksBoard>;
