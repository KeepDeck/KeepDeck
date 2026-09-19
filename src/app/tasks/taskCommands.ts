/**
 * The task commands — `task.create`, `task.list`, `task.get`,
 * `task.update`, `task.comment`, `task.next`, `task.mine` — what an agent
 * uses to put work on its team's board and read it back, and therefore
 * the MCP tools it sees for it.
 *
 * Registered while the Tasks toggle is on and the board is claimed, so a
 * tool exists only when a call can succeed. Every command reads WHO IS
 * CALLING and refuses anyone it cannot place on a team: the caller's team
 * is the board it may read and write, and nothing else.
 *
 * Answers are FACTS about the board. The one sentence that offers a next
 * step — telling the assignee by mail — offers; it does not oblige. The
 * board delivers nothing to anyone.
 */
import {
  resolveTeamRef,
  type CommandArgs,
  type CommandRegistry,
  type CommandSource,
  type CommandSpec,
} from "../../domain/commands";
import {
  findWorkspaceOfPane,
  teamOfPane,
  type Team,
  type Workspace,
} from "../../domain/deck";
import { senderOf } from "../../domain/mail";
import {
  agentActor,
  compareQueue,
  findTask,
  isTaskId,
  isTaskPriority,
  isTaskStatus,
  issuable,
  mine,
  nextFor,
  poolOf,
  tasksOfTeam,
  unblocks,
  type Task,
  type TaskActor,
  type TaskBoard,
  type TaskChange,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import { refusalText } from "./refusalText";
import type { TaskResult, TasksService } from "./tasksService";

export interface TaskCommandDeps {
  tasks: TasksService;
  /** The deck as it stands, as workspaces and nothing else. */
  workspaces(): readonly Workspace[];
}

const NOT_AN_AGENT =
  "only an agent pane can use the task board — this connection is not attached to one";

/** Who is calling, placed on the deck: its workspace, its team and the
 * actor the domain judges it as. */
interface Caller {
  workspace: Workspace;
  team: Team | undefined;
  role: string | undefined;
  actor: TaskActor;
}

function caller(source: CommandSource, deps: TaskCommandDeps): Caller {
  const sender = senderOf(source);
  if (!sender) throw new Error(NOT_AN_AGENT);
  const workspace = findWorkspaceOfPane(deps.workspaces(), sender.paneId);
  const pane = workspace?.panes.find((candidate) => candidate.id === sender.paneId);
  if (!workspace || !pane) throw new Error(NOT_AN_AGENT);
  const team = teamOfPane(workspace, pane);
  const role = pane.team?.role;
  return { workspace, team, role, actor: agentActor(role, team?.id) };
}

/** The team a call is about: the caller's own, or the one it named — which
 * must be its own. A board is read and written by its team only. */
function teamFor(args: CommandArgs, who: Caller): Team {
  const named = str(args, "team");
  if (!who.team) throw new Error(refusalText({ kind: "not-an-agent-on-a-team" }));
  if (named === undefined) return who.team;
  const resolved = resolveTeamRef(who.workspace, named);
  if (!resolved.ok) throw new Error(resolved.message);
  if (resolved.value.id !== who.team.id) {
    throw new Error(
      `a board is read and written by its own team — you stand on "${who.team.name}", not "${resolved.value.name}"`,
    );
  }
  return who.team;
}

function str(args: CommandArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A comma-separated list of ids, as every array argument travels. */
function ids(args: CommandArgs, name: string): string[] | undefined {
  const value = args[name];
  if (typeof value !== "string") return undefined;
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

function priorityArg(args: CommandArgs): TaskPriority | undefined {
  const value = str(args, "priority");
  if (value === undefined) return undefined;
  if (!isTaskPriority(value)) throw new Error(`priority must be high, normal or low, not "${value}"`);
  return value;
}

function statusArg(args: CommandArgs): TaskStatus | undefined {
  const value = str(args, "status");
  if (value === undefined) return undefined;
  if (!isTaskStatus(value)) {
    throw new Error(`status must be todo, doing, blocked, review, done or cancelled, not "${value}"`);
  }
  return value;
}

function taskIdArg(args: CommandArgs): string {
  const value = str(args, "id") ?? "";
  if (!isTaskId(value)) throw new Error(`"${value}" is not a task id — ids look like task-N`);
  return value;
}

/** A task as a list shows it: identity and standing, never the body or
 * the thread — `task.get` carries those. */
function row(task: Task, board: TaskBoard) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    author: task.author,
    blockedBy: task.blockedBy,
    issuable: issuable(task, board),
    artifacts: task.artifacts.length,
    comments: task.comments.length,
    updated: task.updated,
  };
}

/** A task whole, plus what the board knows around it. */
function full(task: Task, board: TaskBoard) {
  return {
    ...task,
    issuable: issuable(task, board),
    blockers: task.blockedBy.map((id) => ({ id, status: findTask(board, id)?.status ?? null })),
    unblocks: unblocks(task, board).map((other) => other.id),
  };
}

function settled(result: TaskResult): Extract<TaskResult, { ok: true }> {
  if (!result.ok) throw new Error(refusalText(result.refusal));
  return result;
}

/** The board a read is about, or the refusal that stands in for it. */
async function boardOf(deps: TaskCommandDeps, workspaceId: string): Promise<TaskBoard> {
  const state = await deps.tasks.ready(workspaceId);
  if (state.kind === "unreadable") {
    throw new Error(refusalText({ kind: "board-unreadable", error: state.error }));
  }
  if (state.kind !== "ready") throw new Error("the board is still loading — ask again");
  return state.board;
}

/** A task the caller may see: on the board, and on the caller's team. */
function visible(board: TaskBoard, id: string, team: Team): Task {
  const task = findTask(board, id);
  if (!task) throw new Error(refusalText({ kind: "unknown-task", id }));
  if (task.teamId !== team.id) throw new Error(refusalText({ kind: "not-on-team" }));
  return task;
}

const TEAM_ARG = {
  name: "team",
  type: "string",
  description: "The team whose board this is about — your own by default, and only your own",
} as const;

function createCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.create",
    title: "Put a task on the team's board",
    args: [
      { name: "title", type: "string", required: true, description: "What to do, in one line (≤120 characters)" },
      { name: "body", type: "string", description: "The brief, markdown (≤8 KiB); a long one belongs in an artifact named under artifacts" },
      { name: "assignee", type: "string", description: "A role address on the team (impl-1); omit for the pool. A working role may name only itself" },
      { name: "priority", type: "string", description: "high | normal | low — normal by default; a working role creates at normal" },
      { name: "blockedBy", type: "string", description: "Task ids this one waits on, comma-separated — same board only" },
      { name: "artifacts", type: "string", description: "Artifact ids to attach, comma-separated" },
      TEAM_ARG,
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const { task } = settled(
        await deps.tasks.create(
          who.workspace.id,
          {
            teamId: team.id,
            title: str(args, "title") ?? "",
            body: typeof args.body === "string" ? args.body : undefined,
            assignee: str(args, "assignee") ?? null,
            priority: priorityArg(args),
            blockedBy: ids(args, "blockedBy"),
            artifacts: ids(args, "artifacts"),
          },
          who.actor,
        ),
      );
      return {
        id: task.id,
        teamId: task.teamId,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee,
        // The board delivers nothing. Said once, as an offer — the
        // assignee learns of the task only if somebody tells them.
        note:
          task.assignee === null
            ? "in the team's pool — anyone on the team may take it; nobody is told by the board"
            : `assigned to ${task.assignee} — the board tells nobody; you can tell them with mail.send, naming ${task.id}`,
      };
    },
  };
}

function listCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.list",
    title: "List the team's tasks",
    args: [
      TEAM_ARG,
      { name: "assignee", type: "string", description: "Only this role's tasks; \"pool\" for the unassigned" },
      { name: "status", type: "string", description: "Only tasks in this status" },
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const board = await boardOf(deps, who.workspace.id);
      const assignee = str(args, "assignee");
      const status = statusArg(args);
      const tasks = tasksOfTeam(board, team.id).filter(
        (task) =>
          (assignee === undefined || task.assignee === (assignee === "pool" ? null : assignee)) &&
          (status === undefined || task.status === status),
      );
      return { count: tasks.length, tasks: tasks.map((task) => row(task, board)) };
    },
  };
}

function getCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.get",
    title: "Read one task whole: brief, thread, log, blockers",
    args: [{ name: "id", type: "string", required: true, description: "The task id (task-N)" }],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const board = await boardOf(deps, who.workspace.id);
      return { task: full(visible(board, taskIdArg(args), team), board) };
    },
  };
}

function updateCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.update",
    title: "Change a task: move it along, reassign it, edit its fields",
    args: [
      { name: "id", type: "string", required: true, description: "The task id (task-N)" },
      { name: "status", type: "string", description: "todo | doing | blocked | review | done | cancelled — the ladder decides which moves are yours" },
      { name: "assignee", type: "string", description: "A role address on the team; \"pool\" to unassign" },
      { name: "priority", type: "string", description: "high | normal | low" },
      { name: "title", type: "string", description: "A new title" },
      { name: "body", type: "string", description: "A new brief" },
      { name: "blockedBy", type: "string", description: "Task ids this one waits on, comma-separated; empty string for none" },
      { name: "artifacts", type: "string", description: "Artifact ids attached, comma-separated; empty string for none" },
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const id = taskIdArg(args);
      const changes: TaskChange[] = [];
      const assignee = str(args, "assignee");
      if (assignee !== undefined) changes.push({ kind: "assign", assignee: assignee === "pool" ? null : assignee });
      const priority = priorityArg(args);
      if (priority !== undefined) changes.push({ kind: "priority", to: priority });
      if (typeof args.title === "string") changes.push({ kind: "title", to: args.title });
      if (typeof args.body === "string") changes.push({ kind: "body", to: args.body });
      const blockedBy = ids(args, "blockedBy");
      if (blockedBy !== undefined) changes.push({ kind: "blockedBy", to: blockedBy });
      const artifacts = ids(args, "artifacts");
      if (artifacts !== undefined) changes.push({ kind: "artifacts", to: artifacts });
      const status = statusArg(args);
      if (status !== undefined) changes.push({ kind: "status", to: status });
      if (changes.length === 0) {
        throw new Error("nothing to change — pass at least one of status, assignee, priority, title, body, blockedBy, artifacts");
      }
      const board = await boardOf(deps, who.workspace.id);
      const before = visible(board, id, team);
      const { task } = settled(await deps.tasks.apply(who.workspace.id, id, changes, who.actor));
      const changed = (["status", "assignee", "priority", "title", "body", "blockedBy", "artifacts"] as const).filter(
        (field) => JSON.stringify(before[field]) !== JSON.stringify(task[field]),
      );
      return { id: task.id, changed, status: task.status, assignee: task.assignee, priority: task.priority };
    },
  };
}

function commentCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.comment",
    title: "Add to a task's thread — it stays with the task",
    args: [
      { name: "id", type: "string", required: true, description: "The task id (task-N)" },
      { name: "body", type: "string", required: true, description: "The comment (≤4000 characters)" },
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const id = taskIdArg(args);
      const board = await boardOf(deps, who.workspace.id);
      visible(board, id, team);
      const body = typeof args.body === "string" ? args.body : "";
      const { task } = settled(await deps.tasks.apply(who.workspace.id, id, [{ kind: "comment", body }], who.actor));
      return { id: task.id, n: task.comments[task.comments.length - 1]?.n ?? 0 };
    },
  };
}

function nextCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.next",
    title: "The head of your queue: your first task that can be started",
    args: [],
    run: async (_args, source) => {
      const who = caller(source, deps);
      const team = teamFor({}, who);
      const board = await boardOf(deps, who.workspace.id);
      const head = who.role === undefined ? null : nextFor(board, team.id, who.role);
      const pool = poolOf(board, team.id).length;
      return {
        task: head === null ? null : row(head, board),
        pool,
        ...(head === null
          ? {
              note:
                pool > 0
                  ? `nothing on your queue can start now; the pool holds ${pool} — task.list assignee=pool shows them, task.update status=doing takes one`
                  : "nothing on your queue can start now, and the pool is empty",
            }
          : {}),
      };
    },
  };
}

function mineCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.mine",
    title: "Everything on your plate: your open tasks, plus the team's review if you accept work",
    args: [],
    run: async (_args, source) => {
      const who = caller(source, deps);
      const team = teamFor({}, who);
      const board = await boardOf(deps, who.workspace.id);
      const standing = who.actor.kind === "agent" ? who.actor.standing : null;
      const tasks = who.role === undefined ? [] : mine(board, team.id, who.role, standing);
      return { count: tasks.length, tasks: tasks.sort(compareQueue).map((task) => row(task, board)) };
    },
  };
}

export function registerTaskCommands(registry: CommandRegistry, deps: TaskCommandDeps): () => void {
  const disposers = [
    createCommand,
    listCommand,
    getCommand,
    updateCommand,
    commentCommand,
    nextCommand,
    mineCommand,
  ].map((command) => registry.register(command(deps)));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
