import { formatAge } from "../../domain/usage";
import {
  isUnkeptBriefEdit,
  TASK_CAPS,
  USER_ACTOR,
  blockerCandidates,
  blockerIdsOf,
  hasBlockerCandidate,
  type BlockerSide,
  blockersOf,
  copiedFromOf,
  copiesOf,
  epicCandidates,
  epicMoveProblem,
  epicOf,
  epicProgress,
  issuable,
  labelsOf,
  parentProblem,
  reachableStatuses,
  tasksOfEpic,
  tasksOfTeam,
  transferProblem,
  unblocks,
  type Task,
  type TaskBoard,
  type TaskPriority,
  type TaskRefusal,
  type TaskStatus,
} from "../../domain/tasks";
import type { StatusRingProps } from "@keepdeck/ui-kit/StatusRing";
import { EPIC_CHIP, blockerChip, epicMark, statusMark, type BlockerChip, type EpicMarkView } from "./taskRowView";
import {
  BOARD_ORDER,
  POOL_CHOICE,
  POOL_LABEL,
  STATUS_LABEL,
  blockerLinkWords,
  openWorkWords,
  priorityChoices,
  type ChoiceView,
  personName,
  statusTone,
  type StatusTone,
} from "./words";

/** A status the person may pick — where the task stands, and every rung
 * the transition table lets them move it to from here. */
export interface StatusChoiceView extends ChoiceView {
  value: TaskStatus;
  tone: StatusTone;
  /** The status's ring beside the label. */
  ring: StatusRingProps;
  /** Shown and refused: an epic's close while its work is open, or a
   * reopening under a closed epic — the picker's note says why. */
  disabled: boolean;
}

/** An epic's tasks on its card: how far it has come, each task, and the
 * two ways to add one. */
export interface EpicSectionView {
  heading: string;
  /** `2 of 5 done`, and the bar's fill (`epicMark`, the one owner). */
  progress: EpicMarkView;
  tasks: { id: string; title: string; ring: StatusRingProps; assignee: string; className: string }[];
  empty: string | null;
  addNew: string;
  /** Null when no task of the team could go under it now. */
  addExisting: string | null;
}

export interface TaskDetailView {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** `task-4 · In progress · by you · updated 25m ago` — the head's one
   * line, after the status dot. */
  meta: string;
  /** The status's ring in the head. */
  statusRing: StatusRingProps;
  body: string;
  bodyEmpty: string | null;
  /** The pool first, then the roster — and the current assignee even off
   * the roster, so the control can show what the task says. */
  assignee: string;
  assigneeOptions: ChoiceView[];
  priorityOptions: ChoiceView[];
  /** What the status picker offers: where the task stands, then where the
   * PERSON may move it — the transition table's answer, in ladder order,
   * never a list spelled in markup. */
  statusOptions: StatusChoiceView[];
  /** Why an option is refused, said in the picker; null when none is. */
  statusNote: string | null;
  /** `EPIC` on an epic's head; null for work. */
  kindChip: string | null;
  /** Work's epic: the picker's value (`""` for none) and its options —
   * none, the epic it is under, and every epic it could go under. Null on
   * an epic, which goes under none. */
  parent: { value: string; options: ChoiceView[] } | null;
  /** An epic's tasks, or null for work. */
  epic: EpicSectionView | null;
  /** Each blocker with where it stands; a resolved one (done, cancelled,
   * gone) holds nothing and is struck through. */
  blockers: (BlockerChip & { removeLabel: string })[];
  blockersEmpty: string | null;
  unblocks: { id: string; title: string }[];
  /** The picker the task opens, of each kind (`PaletteView`): what it may
   * wait on, what may wait on it, what may be attached. Built when asked —
   * when one is open — not on every render of the panel. */
  palette(kind: PaletteKind): PaletteView;
  /** Whether a task could be added on each side — its row's + is offered
   * then, and the menu's item is not refused. */
  canAddBlocker: boolean;
  canAddDependant: boolean;
  /** Whether the Unblocks row is drawn: when something waits on it, or
   * something could be made to (its + is the way to add the first). */
  unblocksShown: boolean;
  /** The word for no task waiting on it, or null when some do. */
  unblocksEmpty: string | null;
  /** Where it was copied from, and the copies made of it — one row each,
   * only when there is something to say. A source no longer on the board
   * is said to be gone. */
  copies: CopyRow[];
  /** Attached artifacts, titled when the registry knows them; a slug the
   * registry no longer holds is still shown — the task said so. */
  artifacts: { slug: string; title: string; known: boolean; openTitle: string; detachLabel: string }[];
  /** The task's labels, each with the name of its × . */
  labels: { label: string; removeLabel: string }[];
  /** The team's other labels — what the add field offers first. Free text
   * is a label too: the vocabulary is whatever tasks carry. */
  labelOptions: string[];
  /** Null while another label fits; the words for why not when full. */
  labelsFull: string | null;
  /** Whether any artifact is left to attach — the + is offered then. */
  canAttach: boolean;
  /** Nothing published to attach: a one-word value, the reason in its
   * tooltip. Null when the workspace has artifacts. */
  attachEmpty: { text: string; title: string } | null;
  /** The task's menu (⋯): what else may be done with it, in order. */
  menu: { label: string; actions: TaskAction[] };
  /** Copying it: the confirm's words — a copy is one more task on the
   * board, never made by a stray click. */
  duplicate: { title: string; message: string; confirm: string; cancel: string };
  /** Handing it to another team: the teams it may go to, and the words of
   * its confirm. */
  transfer: {
    title: string;
    prompt: string;
    options: ChoiceView[];
    /** The team the picker opens on: the first it may go to, or none. */
    initial: string | null;
    confirm: (team: string) => string;
    move: string;
    cancel: string;
  };
  /** What was said, oldest first — the task's substance, always shown,
   * the composer under it (`commentsOf`). */
  comments: CommentItem[];
  commentsEmpty: string | null;
  /** What was changed — the agents' stream of status, label and assignee
   * moves — under its heading, shut until opened (`changesOf`). */
  activity: { label: string; open: boolean };
  changes: FeedChange[];
  changesEmpty: string | null;
  }

export interface FeedChange {
  kind: "change";
  key: string;
  who: string;
  text: string;
  age: string;
}

/** An action the task's menu offers — the component binds each to its
 * intent. A refused one is shown, greyed, with why. */
/** Whether the menu's action is out of reach now: refused by the board, or
 * — a copy on its way — a second copy. */
export function menuActionDisabled(action: TaskAction, copying: boolean): boolean {
  return action.refusal !== null || (action.id === "duplicate" && copying);
}

export interface TaskAction {
  id: "rename" | "blocked-by" | "blocks" | "duplicate" | "transfer";
  label: string;
  refusal: string | null;
}

/** What a task's pickers pick: a task it waits on, a task that waits on
 * it, an artifact to attach. */
export type PaletteKind = BlockerSide | "artifact" | "epic-task";

/** One palette, as the component maps it: its name, the prompt that says
 * what is picked, its sections of rows, and what it says when none match. */
export interface PaletteView {
  label: string;
  placeholder: string;
  empty: string;
  sections: { title: string; items: { value: string; label: string; hint: string; ring?: StatusRingProps }[] }[];
}

export interface CommentItem {
  key: string;
  who: string;
  age: string;
  body: string;
}

/** Every word the panel says that is not the task's own — the component
 * maps these and spells nothing. */
export const TASK_DETAIL_WORDS = {
  panel: (id: string) => `Task ${id}`,
  close: "Close",
  blockers: "Blocked by",
  unblocks: "Unblocks",
  copiedFromLabel: "Copied from",
  copiesLabel: "Copies",
  copyGone: "a task no longer on the board",
  artifacts: "Artifacts",
  labels: "Labels",
  addLabel: "Add a label",
  labelPrompt: "+ label",
  labelsFull: (max: number) => `${max} labels — take one off to add another`,
  comments: "Comments",
  commentsEmpty: "Nothing said yet",
  activity: "Activity",
  changesEmpty: "Nothing changed yet",
  labelAdded: (label: string) => `added label ${label}`,
  copiedFrom: (id: string) => `copied from ${id}`,
  copiedTo: (id: string) => `copied to ${id}`,
  transferred: (from: string, to: string) => `moved from ${from} to ${to}`,
  rename: "Rename",
  renameField: "Task title",
  duplicate: "Duplicate",
  duplicateTitle: (id: string) => `Duplicate ${id}`,
  duplicateMessage: (where: string) =>
    `A new task with its brief, priority, labels and artifacts, under the same title, in ${where}, unassigned — without its comments or history.`,
  transfer: "Transfer",
  transferTitle: (id: string) => `Transfer ${id}`,
  transferPrompt: "To team",
  transferConfirm: (team: string, stops: string | null) =>
    `Move it to ${team}? It goes unassigned, back to To do.${stops ? ` ${stops}` : ""}`,
  transferStops: (status: string, holder: string | null) =>
    holder ? `It is ${status} with ${holder} — that work stops here.` : `It is ${status} — that stops here.`,
  transferMove: "Move",
  cancel: "Cancel",
  transferNoTeam: "No other team in this workspace",
  transferClosed: (status: string) => `A ${status} task stays where it is — duplicate it instead`,
  transferLinked: (links: string) => `Linked by blockers — ${links}; unlink first`,
  menu: (id: string) => `More for ${id}`,
  labelRemoved: (label: string) => `removed label ${label}`,
  briefEdited: (was: string, now: string) => `edited the brief (v${was} → v${now})`,
  briefEditedUnkept: "edited the brief (its earlier text was not kept)",
  detach: "Detach",
  none: "none",
  addBlocker: "Add a blocker",
  addDependant: "Add a task that waits on this one",
  blockedByAction: "Blocked by…",
  blocksAction: "Blocks…",
  blockedByTitle: "Blocked by",
  blocksTitle: "Blocks",
  blockedByPrompt: (id: string) => `Find a task ${id} waits on…`,
  blocksPrompt: (id: string) => `Find a task that waits on ${id}…`,
  tasksSection: "Tasks",
  artifactsSection: "Artifacts",
  noTaskMatches: "No task matches — only the team's open tasks that keep the links free of cycles",
  noArtifactMatches: "No artifact matches",
  nothingToWaitOn: "No task on its team it could wait on",
  nothingWaitsOn: "No task on its team could wait on it",
  removeBlocker: (id: string) => `Stop waiting on ${id}`,
  attach: "Attach artifact",
  attachPrompt: "Find an artifact…",
  addArtifact: "Attach an artifact",
  commentPlaceholder: "Add a comment — it stays with the task",
  comment: "Comment",
  epic: "Epic",
  noEpic: "No epic",
  epicTasks: "Tasks of the epic",
  epicEmpty: "No tasks under it yet",
  epicAddNew: "New task in the epic",
  epicAddExisting: "Add an existing task",
  epicTaskTitle: "Add to the epic",
  epicTaskPrompt: (id: string) => `Find a task to put under ${id}…`,
  noEpicTaskMatches: "No task matches — only the team's work under no epic, open while the epic is",
  epicWaits: (open: string) => `Done and Cancelled wait for the epic's tasks: ${open}`,
  epicClosed: (id: string) => `The epic ${id} is closed — reopen it first`,
  putUnder: (id: string) => `put under the epic ${id}`,
  movedUnder: (was: string, now: string) => `moved from the epic ${was} to ${now}`,
  takenOut: (id: string) => `taken out of the epic ${id}`,
} as const;

/** What a pick in the status picker asks for: a move, or nothing when the
 * person picked where the task already stands. */
export function pickedStatus(current: TaskStatus, picked: string): TaskStatus | null {
  return picked === current ? null : (picked as TaskStatus);
}

/** The panel's classes: wide while the task fills the stage. */
export function taskDetailClassName(wide: boolean): string {
  return wide ? "tasks__detail tasks__detail--wide" : "tasks__detail";
}

/** An artifact as the registry lists it — the two facts a task needs. */
export interface ArtifactRef {
  id: string;
  title: string;
}

export function taskDetailView(
  task: Task,
  board: TaskBoard,
  roster: readonly string[],
  now: number,
  /** The workspace's artifacts, as the registry lists them; empty when the
   * feature is off or nothing is published. */
  artifacts: readonly ArtifactRef[] = [],
  /** The activity (`changesOf`) opened under its heading. */
  activityOpen = false,
  /** The workspace's live teams — where a transfer may go (the deck's). */
  teams: readonly { id: string; name: string }[] = [],
): TaskDetailView {
  const ctx = { board, roster, at: now };
  const others = teams.filter((team) => team.id !== task.teamId);
  const reachable = new Set(reachableStatuses(task, USER_ACTOR, ctx));
  // A move the family rule refuses is shown, greyed, with why — the only
  // rule that binds the person, so the only one the picker explains.
  const family = new Map(BOARD_ORDER.map((to) => [to, to === task.status ? null : epicMoveProblem(task, to, board)] as const));
  const statusOptions = BOARD_ORDER.filter((to) => to === task.status || reachable.has(to) || family.get(to) !== null).map((to) => ({
    value: to,
    label: STATUS_LABEL[to],
    tone: statusTone(to),
    ring: statusMark(to),
    disabled: family.get(to) !== null,
  }));
  const refused = [...family.values()].find((problem) => problem !== null) ?? null;
  const assigneeValues = [...new Set([...roster, ...(task.assignee ? [task.assignee] : [])])];
  const blockedBy = blockerIdsOf(task, board);
  const canAddBlocker = hasBlockerCandidate(task, board, "blocked-by");
  const canAddDependant = hasBlockerCandidate(task, board, "blocks");
  const attachable = artifacts.filter((artifact) => !task.artifacts.includes(artifact.id));
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    meta: [task.id, STATUS_LABEL[task.status], `by ${personName(task.author)}`, `updated ${formatAge(task.updated, now)}`].join(
      " · ",
    ),
    statusRing: statusMark(task.status),
    body: task.body,
    bodyEmpty: task.body.trim() === "" ? "No brief — the title is all there is" : null,
    assignee: task.assignee ?? "",
    assigneeOptions: [
      POOL_CHOICE,
      ...assigneeValues.map((role) => ({ value: role, label: role })),
    ],
    priorityOptions: priorityChoices(),
    statusOptions,
    statusNote: refused === null ? null : familyNote(refused),
    kindChip: task.kind === "epic" ? EPIC_CHIP : null,
    parent: task.kind === "epic" ? null : parentPicker(task, board),
    epic: task.kind === "epic" ? epicSection(task, board) : null,
    blockers: blockersOf(task, board).map((blocker) => ({
      ...blockerChip(blocker),
      removeLabel: TASK_DETAIL_WORDS.removeBlocker(blocker.id),
    })),
    blockersEmpty:
      blockedBy.length > 0 ? null : task.status === "todo" && issuable(task, board) ? "none — can start now" : "none",
    unblocks: unblocks(task, board).map((other) => ({ id: other.id, title: other.title })),
    copies: copyRows(task, board),
    palette: (kind) =>
      kind === "artifact"
        ? artifactPalette(attachable)
        : kind === "epic-task"
          ? epicTaskPalette(task, epicTaskCandidates(task, board))
          : taskPalette(task, blockerCandidates(task, board, kind), kind),
    canAddBlocker,
    canAddDependant,
    unblocksShown: unblocks(task, board).length > 0 || canAddDependant,
    unblocksEmpty: unblocks(task, board).length === 0 ? TASK_DETAIL_WORDS.none : null,
    labels: task.labels.map((label) => ({ label, removeLabel: `Remove ${label}` })),
    labelOptions: labelsOf({ tasks: tasksOfTeam(board, task.teamId) }).filter((label) => !task.labels.includes(label)),
    labelsFull: task.labels.length >= TASK_CAPS.labelsMax ? TASK_DETAIL_WORDS.labelsFull(TASK_CAPS.labelsMax) : null,
    artifacts: task.artifacts.map((slug) => {
      const known = artifacts.find((artifact) => artifact.id === slug);
      return {
        slug,
        title: known?.title ?? slug,
        known: known !== undefined,
        // What a press does, then the durable half a teammate is given.
        openTitle: `${known ? "Open in the browser" : "No longer published"} — ${slug}`,
        detachLabel: `${TASK_DETAIL_WORDS.detach} ${slug}`,
      };
    }),
    canAttach: attachable.length > 0,
    // With every published artifact attached, the chips say it all.
    attachEmpty:
      artifacts.length === 0
        ? { text: "none", title: "Nothing published in this workspace yet — agents attach with task.update artifacts=<id>" }
        : null,
    menu: {
      label: TASK_DETAIL_WORDS.menu(task.id),
      actions: [
        { id: "rename", label: TASK_DETAIL_WORDS.rename, refusal: null },
        {
          id: "blocked-by",
          label: TASK_DETAIL_WORDS.blockedByAction,
          refusal: canAddBlocker ? null : TASK_DETAIL_WORDS.nothingToWaitOn,
        },
        {
          id: "blocks",
          label: TASK_DETAIL_WORDS.blocksAction,
          refusal: canAddDependant ? null : TASK_DETAIL_WORDS.nothingWaitsOn,
        },
        { id: "duplicate", label: TASK_DETAIL_WORDS.duplicate, refusal: null },
        { id: "transfer", label: TASK_DETAIL_WORDS.transfer, refusal: transferRefusal(task, board, others.length) },
      ],
    },
    duplicate: {
      title: TASK_DETAIL_WORDS.duplicateTitle(task.id),
      message: TASK_DETAIL_WORDS.duplicateMessage(task.status === "backlog" ? STATUS_LABEL.backlog : STATUS_LABEL.todo),
      confirm: TASK_DETAIL_WORDS.duplicate,
      cancel: TASK_DETAIL_WORDS.cancel,
    },
    transfer: {
      title: TASK_DETAIL_WORDS.transferTitle(task.id),
      prompt: TASK_DETAIL_WORDS.transferPrompt,
      options: others.map((team) => ({ value: team.id, label: team.name })),
      initial: others[0]?.id ?? null,
      confirm: (team: string) => TASK_DETAIL_WORDS.transferConfirm(team, transferStops(task)),
      move: TASK_DETAIL_WORDS.transferMove,
      cancel: TASK_DETAIL_WORDS.cancel,
    },
    comments: commentsOf(task, now),
    commentsEmpty: task.comments.length === 0 ? TASK_DETAIL_WORDS.commentsEmpty : null,
    activity: { label: TASK_DETAIL_WORDS.activity, open: activityOpen },
    changes: changesOf(task, now),
    changesEmpty: task.log.length === 0 ? TASK_DETAIL_WORDS.changesEmpty : null,
  };
}

/** The title a rename commits, or null when there is nothing to change:
 * the typed text trimmed — empty keeps the title (a task has no automatic
 * name to fall back to; the field's own rule, like Escape), and the title
 * the edit BEGAN with is no edit — so a rename left untouched never writes
 * back over a title an agent changed meanwhile. */
export function renamedTitle(from: string, typed: string): string | null {
  const title = typed.trim();
  return title === "" || title === from ? null : title;
}

/** What a transfer interrupts, said in its confirm: work under way (in
 * progress, blocked, in review) is reset to To do on the new team — the
 * person should know before they move it. Null for work not yet begun. */
function transferStops(task: Task): string | null {
  if (task.status !== "in-progress" && task.status !== "blocked" && task.status !== "review") return null;
  return TASK_DETAIL_WORDS.transferStops(STATUS_LABEL[task.status].toLowerCase(), task.assignee);
}

/** A palette of tasks to link to `task` as `side` says: each by its key
 * and title, its status ring before it and its status after. */
function taskPalette(task: Task, candidates: readonly Task[], side: BlockerSide): PaletteView {
  const blockedBy = side === "blocked-by";
  return {
    label: blockedBy ? TASK_DETAIL_WORDS.blockedByTitle : TASK_DETAIL_WORDS.blocksTitle,
    placeholder: blockedBy ? TASK_DETAIL_WORDS.blockedByPrompt(task.id) : TASK_DETAIL_WORDS.blocksPrompt(task.id),
    empty: TASK_DETAIL_WORDS.noTaskMatches,
    sections: [
      {
        title: TASK_DETAIL_WORDS.tasksSection,
        items: candidates.map((other) => ({
          value: other.id,
          label: `${other.id}  ${other.title}`,
          hint: STATUS_LABEL[other.status],
          ring: statusMark(other.status),
        })),
      },
    ],
  };
}

/** The words for a move the family rule refused. */
function familyNote(problem: TaskRefusal): string | null {
  if (problem.kind === "epic-has-open-work") return TASK_DETAIL_WORDS.epicWaits(openWorkWords(problem.open));
  if (problem.kind === "closed-epic") return TASK_DETAIL_WORDS.epicClosed(problem.id);
  return null;
}

/** Work's epic picker: none, the epic it is under, then each it could go
 * under — the rule's own list (`epicCandidates`). */
function parentPicker(task: Task, board: TaskBoard): { value: string; options: ChoiceView[] } {
  const current = epicOf(task, board);
  const choice = (epic: Task) => ({ value: epic.id, label: `${epic.id} · ${epic.title}` });
  return {
    value: current?.id ?? "",
    options: [{ value: "", label: TASK_DETAIL_WORDS.noEpic }, ...(current ? [choice(current)] : []), ...epicCandidates(task, board).map(choice)],
  };
}

/** The tasks of `epic`'s team that could be put under it now: work under
 * no epic that the family rule lets in. */
function epicTaskCandidates(epic: Task, board: TaskBoard): Task[] {
  return tasksOfTeam(board, epic.teamId).filter((task) => epicOf(task, board) === null && parentProblem(task, epic.id, board) === null);
}

function epicSection(epic: Task, board: TaskBoard): EpicSectionView {
  const tasks = tasksOfEpic(epic, board);
  const progress = epicProgress(epic, board);
  return {
    heading: TASK_DETAIL_WORDS.epicTasks,
    progress: epicMark(progress),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      ring: statusMark(task.status),
      assignee: personName(task.assignee ?? POOL_LABEL),
      className: `tasks__epic-task tasks__epic-task--${task.status}`,
    })),
    empty: tasks.length === 0 ? TASK_DETAIL_WORDS.epicEmpty : null,
    addNew: TASK_DETAIL_WORDS.epicAddNew,
    addExisting: epicTaskCandidates(epic, board).length > 0 ? TASK_DETAIL_WORDS.epicAddExisting : null,
  };
}

/** The palette of tasks to put under an epic: each by its key and title,
 * its status ring before it and its status after. */
function epicTaskPalette(epic: Task, candidates: readonly Task[]): PaletteView {
  return {
    label: TASK_DETAIL_WORDS.epicTaskTitle,
    placeholder: TASK_DETAIL_WORDS.epicTaskPrompt(epic.id),
    empty: TASK_DETAIL_WORDS.noEpicTaskMatches,
    sections: [
      {
        title: TASK_DETAIL_WORDS.tasksSection,
        items: candidates.map((other) => ({
          value: other.id,
          label: `${other.id}  ${other.title}`,
          hint: STATUS_LABEL[other.status],
          ring: statusMark(other.status),
        })),
      },
    ],
  };
}

/** The palette of artifacts to attach: each by its title, its slug after. */
function artifactPalette(attachable: readonly ArtifactRef[]): PaletteView {
  return {
    label: TASK_DETAIL_WORDS.attach,
    placeholder: TASK_DETAIL_WORDS.attachPrompt,
    empty: TASK_DETAIL_WORDS.noArtifactMatches,
    sections: [
      {
        title: TASK_DETAIL_WORDS.artifactsSection,
        items: attachable.map((artifact) => ({ value: artifact.id, label: artifact.title, hint: artifact.id })),
      },
    ],
  };
}

/** Why the person may not hand this task to another team now, in words —
 * the domain's rule (`transferProblem`) asked as the user, plus the one
 * thing only the deck knows: that there is another team to hand it to. */
function transferRefusal(task: Task, board: TaskBoard, otherTeams: number): string | null {
  if (otherTeams === 0) return TASK_DETAIL_WORDS.transferNoTeam;
  const problem = transferProblem(task, USER_ACTOR, board);
  if (problem === null) return null;
  if (problem.kind === "transfer-closed") return TASK_DETAIL_WORDS.transferClosed(STATUS_LABEL[problem.status].toLowerCase());
  if (problem.kind === "transfer-linked") {
    return TASK_DETAIL_WORDS.transferLinked(blockerLinkWords(problem).join(", "));
  }
  return null;
}

/** One row of a task's copy links: what it names, the tasks it links to
 * (each opens), and what to say of an end no longer on the board. */
export interface CopyRow {
  label: string;
  tasks: { id: string; title: string }[];
  gone: string | null;
}

/** A task's copy links as rows: its source, then its copies. */
function copyRows(task: Task, board: TaskBoard): CopyRow[] {
  const source = copiedFromOf(task, board);
  const copies = copiesOf(task, board);
  return [
    ...(source === null
      ? []
      : [
          {
            label: TASK_DETAIL_WORDS.copiedFromLabel,
            tasks: source === "absent" ? [] : [{ id: source.id, title: source.title }],
            gone: source === "absent" ? TASK_DETAIL_WORDS.copyGone : null,
          },
        ]),
    ...(copies.length === 0
      ? []
      : [
          {
            label: TASK_DETAIL_WORDS.copiesLabel,
            tasks: copies.map((copy) => ({ id: copy.id, title: copy.title })),
            gone: null,
          },
        ]),
  ];
}

/** What was said, oldest first (the order the board keeps). */
export function commentsOf(task: Pick<Task, "comments">, now: number): CommentItem[] {
  return task.comments.map((comment) => ({
    key: `comment-${comment.n}`,
    who: personName(comment.from),
    age: formatAge(comment.at, now),
    body: comment.body,
  }));
}

/**
 * What was changed, oldest first, every entry — nothing folds: a fold hid
 * the very lines a reader opened the activity for.
 */
export function changesOf(task: Pick<Task, "log">, now: number): FeedChange[] {
  // A change's key is what it is — its moment and field, counted among
  // its twins — never its place, so a line keeps its key whatever comes
  // before it.
  const seen = new Map<string, number>();
  return task.log.flatMap((entry) => {
    const base = `change-${entry.at}-${entry.field}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return changeItems(entry, n === 0 ? base : `${base}-${n}`, now);
  });
}

/** What one log entry says in the timeline — usually one line. A labels
 * entry holds the set before and after; the timeline says what moved: a
 * line per label put on or taken off ("added label ui"), never the two
 * sets side by side. */
function changeItems(entry: Task["log"][number], key: string, now: number): FeedChange[] {
  const line = (text: string, suffix = ""): FeedChange => ({
    kind: "change",
    key: key + suffix,
    who: personName(entry.from),
    text,
    age: formatAge(entry.at, now),
  });
  if (entry.field === "labels") {
    const before = labelSet(entry.was);
    const after = labelSet(entry.now);
    return [
      ...after.filter((label) => !before.includes(label)).map((label) => line(TASK_DETAIL_WORDS.labelAdded(label), `+${label}`)),
      ...before.filter((label) => !after.includes(label)).map((label) => line(TASK_DETAIL_WORDS.labelRemoved(label), `-${label}`)),
    ];
  }
  if (entry.field === "copiedFrom") return [line(TASK_DETAIL_WORDS.copiedFrom(entry.now ?? "—"))];
  if (entry.field === "copiedTo") return [line(TASK_DETAIL_WORDS.copiedTo(entry.now ?? "—"))];
  if (entry.field === "transferred") return [line(TASK_DETAIL_WORDS.transferred(entry.was ?? "—", entry.now ?? "—"))];
  if (entry.field === "parent") {
    if (entry.was === null) return [line(TASK_DETAIL_WORDS.putUnder(entry.now ?? "—"))];
    if (entry.now === null) return [line(TASK_DETAIL_WORDS.takenOut(entry.was))];
    return [line(TASK_DETAIL_WORDS.movedUnder(entry.was, entry.now))];
  }
  if (isUnkeptBriefEdit(entry)) return [line(TASK_DETAIL_WORDS.briefEditedUnkept)];
  if (entry.field === "body") return [line(TASK_DETAIL_WORDS.briefEdited(entry.was ?? "—", entry.now ?? "—"))];
  return [line(`${entry.field}: ${entry.was ?? "—"} → ${entry.now ?? "—"}`)];
}

/** A logged label set ("a,b"; null for none) as its labels. */
function labelSet(joined: string | null): string[] {
  return joined === null ? [] : joined.split(",");
}
