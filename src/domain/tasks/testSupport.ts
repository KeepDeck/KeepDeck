import { agentActor, type Task, type TaskBoard } from "./model";

/** A task with every field defaulted — tests name only what they assert. */
export const task = (over: Partial<Task> & Pick<Task, "id">): Task => ({
  teamId: "team-1",
  title: `Task ${over.id}`,
  body: "",
  status: "todo",
  priority: "normal",
  assignee: null,
  author: "lead",
  blockedBy: [],
  artifacts: [],
  comments: [],
  log: [],
  created: 1_000,
  updated: 1_000,
  ...over,
});

export const board = (tasks: Task[], nextId = tasks.length + 1): TaskBoard => ({
  nextId,
  tasks,
});

export const ROSTER = ["lead", "impl-1", "impl-2"] as const;

export const lead = agentActor("lead", "team-1");
export const impl1 = agentActor("impl-1", "team-1");
export const impl2 = agentActor("impl-2", "team-1");
export const peer1 = agentActor("peer-1", "team-1");
/** Same role, another team: the boundary every write is judged against. */
export const stranger = agentActor("impl-1", "team-2");
export const noTeam = agentActor(undefined, undefined);
