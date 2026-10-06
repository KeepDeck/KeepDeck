import { agentActor, type Task, type TaskBoard, type TaskRelation } from "./model";
import { withRelations } from "./relations";

/** The blockers a test wrote on a task, by key — turned into `blocks`
 * links when the task is put on a `board`. */
const written = new WeakMap<Task, readonly string[]>();

/** A task with every field defaulted — tests name only what they assert.
 * Its uid is `uid-<id>`, so a test can name a link's ends; `blockedBy`
 * (keys) becomes `blocks` links on the `board` it is put on. */
export const task = ({ blockedBy, ...over }: Partial<Task> & Pick<Task, "id"> & { blockedBy?: readonly string[] }): Task => {
  const made = build(over);
  if (blockedBy && blockedBy.length > 0) written.set(made, blockedBy);
  return made;
};

const build = (over: Partial<Task> & Pick<Task, "id">): Task => ({
  uid: `uid-${over.id}`,
  teamId: "team-1",
  kind: "task",
  title: `Task ${over.id}`,
  body: "",
  status: "todo",
  priority: "normal",
  assignee: null,
  author: "lead",
  artifacts: [],
  labels: [],
  bodyV: 1,
  briefs: [],
  comments: [],
  log: [],
  created: 1_000,
  updated: 1_000,
  ...over,
});

/** A board of `tasks`, linked as their `blockedBy` said, plus `extra`. */
export const board = (tasks: Task[], nextId = tasks.length + 1, extra: readonly TaskRelation[] = []): TaskBoard => {
  const uidOf = new Map(tasks.map((t) => [t.id, t.uid]));
  const blocks = tasks.flatMap((t) =>
    (written.get(t) ?? []).map((key): TaskRelation => ({
      kind: "blocks",
      from: uidOf.get(key) ?? `uid-${key}`,
      to: t.uid,
      at: t.created,
      by: t.author,
    })),
  );
  return withRelations({ nextId, tasks, relations: [] }, [...blocks, ...extra]);
};

/** A link between two tasks by their keys (`uid-<key>` ends). */
export const relation = (kind: string, from: string, to: string, at = 1_000, by: string | null = "lead"): TaskRelation => ({
  kind,
  from: `uid-${from}`,
  to: `uid-${to}`,
  at,
  by,
});

/** A uid mint for a test: `uid-new-1`, `uid-new-2`, … */
export const mintSequence = (prefix = "uid-new-"): (() => string) => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

export const ROSTER = ["lead", "impl-1", "impl-2"] as const;

export const lead = agentActor("lead", "team-1");
export const impl1 = agentActor("impl-1", "team-1");
export const impl2 = agentActor("impl-2", "team-1");
export const peer1 = agentActor("peer-1", "team-1");
/** Same role, another team: the boundary every write is judged against. */
export const stranger = agentActor("impl-1", "team-2");
export const noTeam = agentActor(undefined, undefined);
