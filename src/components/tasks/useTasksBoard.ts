import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TasksService } from "../../app/tasks";
import { refusalOf, tasksEnableStatus } from "../../app/tasks/enableStatus";
import { refusalText } from "../../app/tasks/refusalText";
import { teamsOf, type Workspace } from "../../domain/deck";
import {
  USER_ACTOR,
  findTask,
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
  const [showDropped, setShowDropped] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<TaskStatus>>(new Set());
  const [composing, setComposing] = useState(false);
  /** The open task filling the stage, the board put away behind it. */
  const [wide, setWide] = useState(false);
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
  const teamTasks = useMemo(
    () => (board && teamId !== null ? tasksOfTeam(board, teamId) : []),
    [board, teamId],
  );
  const roster = useMemo(
    () => (service && workspaceId !== null && teamId !== null ? service.rosterOf(workspaceId, teamId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, teamId, revision],
  );

  const ladder = tasksLadder({
    workspaceId,
    hasTeam: teamId !== null,
    ownerUp: service !== null,
    enableRefusal,
    state,
    taskCount: teamTasks.length,
  });

  const selected = board && focus !== null ? (findTask(board, focus) ?? null) : null;
  const detail = selected && selected.teamId === teamId ? taskDetailView(selected, board!, roster, now) : null;
  const columns = board ? boardView(teamTasks, board, { showDropped, expanded, now }) : [];
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
    showDropped,
    toggleDropped: () => setShowDropped((current) => !current),
    toggleColumn: (status: TaskStatus) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(status)) next.delete(status);
        else next.add(status);
        return next;
      }),
    columns,
    lanes,
    detail,
    select: (taskId: string | null) => {
      setComposing(false);
      onFocus(taskId);
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
    move: (taskId: string, to: TaskStatus) => apply(taskId, [{ kind: "status", to }]),
    assign: (taskId: string, assignee: string) => apply(taskId, [{ kind: "assign", assignee: assignee === "" ? null : assignee }]),
    setPriority: (taskId: string, to: TaskPriority) => apply(taskId, [{ kind: "priority", to }]),
    comment: (taskId: string, body: string) => apply(taskId, [{ kind: "comment", body }]),
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
