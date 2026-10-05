/**
 * The task commands — `task.create`, `task.duplicate`, `task.transfer`,
 * `task.list`, `task.search`, `task.get`, `task.history`, `task.since`,
 * `task.brief`, `task.update`, `task.comment` — what an agent uses to put
 * work on its team's board and read it back, and therefore the MCP tools
 * it sees for it.
 *
 * What an answer costs follows the work in flight and what changed, never
 * the board's age (task-221): a list names the statuses it wants, closed
 * work is read only when asked for, a task's history is its own command,
 * and every answer carries counts (`more`) of what it left for another
 * call — the agent sees it is there, and fetches it when it needs it.
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
  TASK_FIELDS,
  acceptsWork,
  awaitingDecision,
  isOpen,
  agentActor,
  blockerIdsOf,
  copiedFromOf,
  copiesOf,
  findTask,
  isTaskId,
  isTaskPriority,
  TASK_STATUSES,
  isTaskStatus,
  type CreateStatus,
  issuable,
  normalizeLabel,
  countByStatus,
  tasksOfTeam,
  unblocks,
  type Task,
  type TaskActor,
  type TaskBoard,
  type TaskChange,
  type TaskField,
  type TaskPriority,
  type TaskStatus,
} from "../../domain/tasks";
import { notCarriedText, refusalText } from "./refusalText";
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
    throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}, not "${value}"`);
  }
  return value;
}

function taskIdArg(args: CommandArgs): string {
  const value = str(args, "id") ?? "";
  if (!isTaskId(value)) throw new Error(`"${value}" is not a task id — ids look like task-N`);
  return value;
}

/** What an answer leaves for another call, counted: the agent sees it is
 * there. Comments, the change log and earlier briefs come by `task.history`
 * (a closed task's comments too); an open task's comments come in `task.get`. */
function more(task: Task) {
  return { comments: task.comments.length, history: task.log.length, briefVersions: task.briefs.length };
}

/** A task as a list shows it: identity and standing, never the body or
 * the thread — `task.get` and `task.history` carry those. */
function row(task: Task, board: TaskBoard) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    author: task.author,
    blockedBy: blockerIdsOf(task, board),
    labels: task.labels,
    issuable: issuable(task, board),
    artifacts: task.artifacts.length,
    updated: task.updated,
    more: more(task),
  };
}

/** A task as it stands now, plus what the board knows around it: its
 * brief whole, and — while it is open — its discussion. Its log and earlier
 * briefs are `task.history`'s; a closed task's comments are too (closed
 * work is read when asked for, and its threads are the board's longest).
 * Its uid stays out: an agent addresses a task by its key alone. */
function full(task: Task, board: TaskBoard) {
  const { uid: _uid, log: _log, briefs: _briefs, comments, ...shown } = task;
  const source = copiedFromOf(task, board);
  const blockedBy = blockerIdsOf(task, board);
  return {
    ...shown,
    ...(isOpen(task.status) ? { comments } : {}),
    more: more(task),
    blockedBy,
    issuable: issuable(task, board),
    blockers: blockedBy.map((id) => ({ id, status: findTask(board, id)?.status ?? null })),
    unblocks: unblocks(task, board).map((other) => other.id),
    /** The key of the task this was copied from — null for a task that is
     * no copy, "gone" when the source has left the board. */
    copiedFrom: source === null ? null : source === "absent" ? "gone" : source.id,
    copies: copiesOf(task, board).map((copy) => copy.id),
  };
}

/** A field as a change reads it — `blockedBy` from the board's links. */
function fieldOf(task: Task, board: TaskBoard, field: TaskField): unknown {
  return field === "blockedBy" ? blockerIdsOf(task, board) : task[field];
}

/** The one sentence a caller hears when its change is held but not yet
 * on disk. Empty when it landed. */
function unsavedNote(saved: boolean, saveError: string | null): string {
  return saved ? "" : ` — NOT saved to disk yet (${saveError ?? "unknown"}); the board keeps it in memory and retries`;
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
      { name: "labels", type: "string", description: "Labels, comma-separated — at most 5 words (lowercase, dashes between, ≤24 characters); \"Copy Edit\" is kept as copy-edit" },
      { name: "status", type: "string", description: "todo (default) | backlog — backlog parks it: on the board, never issuable, until whoever hands out work moves it to todo" },
      TEAM_ARG,
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      // Where it may start is the domain's to judge (createTask).
      const status = str(args, "status");
      const { task, saved, saveError } = settled(
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
            labels: ids(args, "labels"),
            status: status as CreateStatus | undefined,
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
        saved,
        // The board delivers nothing. Said once, as an offer — the
        // assignee learns of the task only if somebody tells them.
        note:
          (task.assignee === null
            ? "in the team's pool — anyone on the team may take it; nobody is told by the board"
            : `assigned to ${task.assignee} — the board tells nobody; you can tell them with mail.send, naming ${task.id}`) +
          unsavedNote(saved, saveError),
      };
    },
  };
}

function duplicateCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.duplicate",
    title:
      "Copy a task as a fresh one under the SAME title: its brief, priority, labels, artifacts and the blockers still open, in todo (the backlog if it is parked), held by no one — not its comments, log or assignee. The copy is linked to its source (task.get: copiedFrom on the copy, copies on the source), and both logs say so",
    args: [{ name: "id", type: "string", required: true, description: "The task to copy (task-N)" }, TEAM_ARG],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const board = await boardOf(deps, who.workspace.id);
      const original = visible(board, taskIdArg(args), team);
      const result = await deps.tasks.duplicate(who.workspace.id, original.id, who.actor);
      const { task, saved, saveError } = settled(result);
      // What the create's rules left out is the domain's answer, said here.
      const left = result.ok ? notCarriedText(result.notCarried) : null;
      const where = task.status === "backlog" ? "parked in the team's backlog" : "in the team's pool";
      return {
        id: task.id,
        copiedFrom: original.id,
        status: task.status,
        priority: task.priority,
        saved,
        note: `copied from ${original.id}, ${where}` + (left ? `; ${left}` : "") + unsavedNote(saved, saveError),
      };
    },
  };
}

function transferCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.transfer",
    title:
      "Hand a task to another team of this workspace: the same task (id, brief, labels, comments and log kept) on their board, unassigned, back in todo (the backlog if it is parked). Yours to do if you hand out work; refused for a closed task, or one still linked by blockers to your team",
    args: [
      { name: "id", type: "string", required: true, description: "The task to hand over (task-N)" },
      { name: "to", type: "string", required: true, description: "The team to hand it to — its name or id, in this workspace" },
      TEAM_ARG,
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const board = await boardOf(deps, who.workspace.id);
      const task = visible(board, taskIdArg(args), team);
      const target = resolveTeamRef(who.workspace, str(args, "to") ?? "");
      if (!target.ok) throw new Error(target.message);
      const { saved, saveError } = settled(
        await deps.tasks.transfer(who.workspace.id, task.id, target.value.id, who.actor),
      );
      return {
        id: task.id,
        team: target.value.name,
        saved,
        // The board delivers nothing — the new team hears of it only if told.
        note:
          `on ${target.value.name}'s board now, unassigned — the board tells nobody; tell its lead with mail.send, naming ${task.id}` +
          // Who held it loses it without a word from the board, too.
          (task.assignee !== null ? `, and ${task.assignee}, who held it` : "") +
          unsavedNote(saved, saveError),
      };
    },
  };
}

/** The statuses a call names, one or several ("todo,in-progress") — every
 * one a status there is. */
function statusesArg(args: CommandArgs, required: boolean): TaskStatus[] | undefined {
  const named = ids(args, "status");
  if (named === undefined || named.length === 0) {
    if (required) throw new Error(`name the statuses you want — one or several of ${TASK_STATUSES.join(", ")} (closed work is done, cancelled)`);
    return undefined;
  }
  for (const status of named) {
    if (!isTaskStatus(status)) throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}, not "${status}"`);
  }
  return named as TaskStatus[];
}

/** A team's tasks matching the filters every list-shaped answer shares. */
function matching(board: TaskBoard, team: Team, args: CommandArgs, statuses: readonly TaskStatus[] | undefined): Task[] {
  const assignee = str(args, "assignee");
  const priority = priorityArg(args);
  const label = str(args, "label");
  const wanted = label === undefined ? undefined : normalizeLabel(label);
  if (wanted === "") throw new Error(`"${label}" is not a label`);
  return tasksOfTeam(board, team.id).filter(
    (task) =>
      (statuses === undefined || statuses.includes(task.status)) &&
      (assignee === undefined || task.assignee === (assignee === "pool" ? null : assignee)) &&
      (priority === undefined || task.priority === priority) &&
      (wanted === undefined || task.labels.includes(wanted)),
  );
}

const FILTER_ARGS = [
  { name: "assignee", type: "string", description: "Only this role's tasks; \"pool\" for the unassigned" },
  { name: "priority", type: "string", description: "Only tasks of this priority: high | normal | low" },
  { name: "label", type: "string", description: "Only tasks carrying this label" },
] as const;

/** The board's latest change number — what `task.since` takes next. */
function revOf(deps: TaskCommandDeps, workspaceId: string): number | null {
  return deps.tasks.revisions(workspaceId)?.board ?? null;
}

const MORE_NOTE = "`more` counts what is left for task.history: comments, the change log, earlier briefs";

function listCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.list",
    title: `List the team's tasks in the statuses you name — per task: id, title, status, priority, assignee (null = pool), author, blockedBy, labels, issuable (can be started now: in todo with every blocker done or cancelled), artifacts (count), updated. ${MORE_NOTE}. Closed work (done, cancelled) only when you name it; task.search finds a task by its words`,
    args: [
      { name: "status", type: "string", required: true, description: "One or several statuses, comma-separated: backlog, todo, in-progress, blocked, review, done, cancelled" },
      ...FILTER_ARGS,
      TEAM_ARG,
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const statuses = statusesArg(args, true);
      const board = await boardOf(deps, who.workspace.id);
      const tasks = matching(board, team, args, statuses);
      return { count: tasks.length, tasks: tasks.map((task) => row(task, board)), rev: revOf(deps, who.workspace.id) };
    },
  };
}

/** How many hits a search returns unless told otherwise. */
const SEARCH_LIMIT = 20;

function searchCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.search",
    title: `Find the team's tasks by their words — title, brief and comments, closed work included — best match first, each with where it matched (its brief, or comment n) and the words around it. ${MORE_NOTE}`,
    args: [
      { name: "query", type: "string", required: true, description: "The words to find; a word being typed matches as a prefix" },
      { name: "status", type: "string", description: "Only these statuses, comma-separated" },
      ...FILTER_ARGS,
      { name: "limit", type: "number", description: `At most this many hits (${SEARCH_LIMIT} by default)` },
      TEAM_ARG,
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const query = str(args, "query");
      if (query === undefined) throw new Error("say what to find");
      const statuses = statusesArg(args, false);
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : SEARCH_LIMIT;
      const board = await boardOf(deps, who.workspace.id);
      // Asked of the whole board, then held to this caller's team and filters.
      const allowed = new Set(matching(board, team, args, statuses).map((task) => task.uid));
      const hits = (await deps.tasks.search(who.workspace.id, query, limit * 4)).filter((hit) => allowed.has(hit.uid)).slice(0, limit);
      return {
        count: hits.length,
        hits: hits.map((hit) => {
          const task = board.tasks.find((t) => t.uid === hit.uid)!;
          return { ...row(task, board), matched: hit.comment === null ? "brief" : `comment ${hit.comment}`, snippet: hit.snippet };
        }),
        rev: revOf(deps, who.workspace.id),
      };
    },
  };
}

function getCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.get",
    title: `Read one task as it stands: its brief whole, its thread while it is open, blockers with their statuses, what it unblocks, issuable (can be started now), copiedFrom (the key it was copied from, "gone" if that task left the board, null if it is no copy) and copies. ${MORE_NOTE} — a closed task's comments are there too`,
    args: [{ name: "id", type: "string", required: true, description: "The task id (task-N)" }],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const board = await boardOf(deps, who.workspace.id);
      return { task: full(visible(board, taskIdArg(args), team), board), rev: revOf(deps, who.workspace.id) };
    },
  };
}

const HISTORY_KINDS = ["log", "comments", "briefs"] as const;
type HistoryKind = (typeof HISTORY_KINDS)[number];

function historyCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.history",
    title: "A task's past, one kind at a time: its change log (who moved what, when — a brief edit names the versions), its comments, or its earlier briefs (each version's text)",
    args: [
      { name: "id", type: "string", required: true, description: "The task id (task-N)" },
      { name: "kind", type: "string", description: "log (default) | comments | briefs" },
      { name: "field", type: "string", description: "For the log: only changes of this field (status, assignee, body, …)" },
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const kind = (str(args, "kind") ?? "log") as HistoryKind;
      if (!HISTORY_KINDS.includes(kind)) throw new Error(`kind must be ${HISTORY_KINDS.join(", ")}, not "${kind}"`);
      const board = await boardOf(deps, who.workspace.id);
      const task = visible(board, taskIdArg(args), team);
      if (kind === "comments") return { id: task.id, comments: task.comments };
      if (kind === "briefs") return { id: task.id, current: task.bodyV, briefs: task.briefs };
      const field = str(args, "field");
      return { id: task.id, log: field === undefined ? task.log : task.log.filter((entry) => entry.field === field) };
    },
  };
}

function sinceCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.since",
    title: `What changed on the team's board since a mark: the tasks touched since then, as task.list rows. The mark is a rev — every task answer carries the board's, exact — or a time (ISO 8601, "2026-10-06T10:00"), which counts a task changed at that moment as changed. ${MORE_NOTE}`,
    args: [
      { name: "since", type: "string", required: true, description: "A rev from an earlier answer, or an ISO time" },
      TEAM_ARG,
    ],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      const mark = str(args, "since") ?? "";
      const board = await boardOf(deps, who.workspace.id);
      const revisions = deps.tasks.revisions(who.workspace.id);
      const changed = changedSince(board, team, mark, revisions?.tasks ?? new Map());
      return { count: changed.length, tasks: changed.map((task) => row(task, board)), rev: revisions?.board ?? null };
    },
  };
}

/** The team's tasks changed after `mark` — a rev (exact) or a time (from it on). */
function changedSince(board: TaskBoard, team: Team, mark: string, revs: ReadonlyMap<string, number>): Task[] {
  const tasks = tasksOfTeam(board, team.id);
  if (/^\d+$/.test(mark)) {
    const rev = Number(mark);
    return tasks.filter((task) => (revs.get(task.uid) ?? 0) > rev);
  }
  const at = Date.parse(mark);
  if (Number.isNaN(at)) throw new Error(`"${mark}" is neither a rev nor a time — give a rev from an earlier answer, or an ISO time`);
  return tasks.filter((task) => task.updated >= at);
}

function briefCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.brief",
    title: "For whoever hands out work: the team's board at a glance — how many tasks stand in each open status, and what waits on your decision (tasks in review to accept or send back, tasks blocked), with the board's rev for task.since",
    args: [TEAM_ARG],
    run: async (args, source) => {
      const who = caller(source, deps);
      const team = teamFor(args, who);
      if (who.actor.kind === "agent" && !acceptsWork(who.actor.standing)) {
        throw new Error("task.brief is for whoever hands out work — your own tasks: task.list status=todo,in-progress,review,blocked assignee=<you>");
      }
      const board = await boardOf(deps, who.workspace.id);
      const counts = countByStatus(tasksOfTeam(board, team.id));
      const open = Object.fromEntries(TASK_STATUSES.filter(isOpen).map((status) => [status, counts[status]]));
      return {
        board: open,
        waitingOnYou: awaitingDecision(board, team.id).map((task) => row(task, board)),
        rev: revOf(deps, who.workspace.id),
      };
    },
  };
}

function updateCommand(deps: TaskCommandDeps): CommandSpec {
  return {
    id: "task.update",
    title: "Change a task: move it along, reassign it, edit its fields",
    args: [
      { name: "id", type: "string", required: true, description: "The task id (task-N)" },
      { name: "status", type: "string", description: "backlog | todo | in-progress | blocked | review | done | cancelled. One step at a time: todo → in-progress → review → done, in-progress ⇄ blocked; backlog ⇄ todo parks and unparks your own task; accepting, returning, reopening and cancelling are for whoever hands out work. A refused move says where the task can go from where it is" },
      { name: "assignee", type: "string", description: "A role address on the team; \"pool\" to unassign" },
      { name: "priority", type: "string", description: "high | normal | low" },
      { name: "title", type: "string", description: "A new title" },
      { name: "body", type: "string", description: "A new brief" },
      { name: "blockedBy", type: "string", description: "Task ids this one waits on, comma-separated; empty string for none" },
      { name: "artifacts", type: "string", description: "Artifact ids attached, comma-separated; empty string for none" },
      { name: "labels", type: "string", description: "The task's labels, comma-separated, replacing the set; empty string for none. The assignee labels its own task; the lead any" },
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
      const labels = ids(args, "labels");
      if (labels !== undefined) changes.push({ kind: "labels", to: labels });
      const status = statusArg(args);
      if (status !== undefined) changes.push({ kind: "status", to: status });
      if (changes.length === 0) {
        throw new Error("nothing to change — pass at least one of status, assignee, priority, title, body, blockedBy, artifacts, labels");
      }
      const board = await boardOf(deps, who.workspace.id);
      const before = visible(board, id, team);
      const { task, board: after, saved, saveError } = settled(await deps.tasks.apply(who.workspace.id, id, changes, who.actor));
      const changed = TASK_FIELDS.filter(
        (field) => JSON.stringify(fieldOf(before, board, field)) !== JSON.stringify(fieldOf(task, after, field)),
      );
      return {
        id: task.id,
        changed,
        status: task.status,
        assignee: task.assignee,
        priority: task.priority,
        saved,
        ...(saved ? {} : { note: unsavedNote(saved, saveError).trim() }),
      };
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
      const { task, saved, saveError } = settled(
        await deps.tasks.apply(who.workspace.id, id, [{ kind: "comment", body }], who.actor),
      );
      return {
        id: task.id,
        n: task.comments[task.comments.length - 1]?.n ?? 0,
        saved,
        ...(saved ? {} : { note: unsavedNote(saved, saveError).trim() }),
      };
    },
  };
}

export function registerTaskCommands(registry: CommandRegistry, deps: TaskCommandDeps): () => void {
  const disposers = [
    createCommand,
    duplicateCommand,
    transferCommand,
    listCommand,
    searchCommand,
    getCommand,
    historyCommand,
    sinceCommand,
    briefCommand,
    updateCommand,
    commentCommand,
  ].map((command) => registry.register(command(deps)));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
