import type { BoardState } from "../../app/tasks/tasksService";
import { NEW_TASK_LABEL } from "./words";

/**
 * Which of the dialog's states the body shows — the artifacts registry's
 * ladder, for the board. Telling them apart is a decision, not a
 * rendering, so it lives here where it can be asserted without a DOM.
 */
export type TasksLadder =
  | { kind: "noWorkspace" }
  | { kind: "noTeam" }
  | { kind: "loading" }
  /** The backend said why it cannot answer; its words, verbatim. */
  | { kind: "refusal"; message: string }
  | { kind: "empty" }
  | { kind: "board" };

export function tasksLadder(input: {
  workspaceId: string | null;
  /** Whether the workspace has a team to show a board for. */
  hasTeam: boolean;
  /** Whether the owner exists — null while the feature's backend is not up. */
  ownerUp: boolean;
  /** Why the backend is down, when it is and said so. */
  enableRefusal: string | null;
  state: BoardState | null;
  taskCount: number;
}): TasksLadder {
  if (input.workspaceId === null) return { kind: "noWorkspace" };
  if (!input.ownerUp) {
    return input.enableRefusal !== null ? { kind: "refusal", message: input.enableRefusal } : { kind: "loading" };
  }
  if (!input.hasTeam) return { kind: "noTeam" };
  if (input.state === null || input.state.kind === "loading") return { kind: "loading" };
  if (input.state.kind === "unreadable") return { kind: "refusal", message: input.state.error };
  return input.taskCount === 0 ? { kind: "empty" } : { kind: "board" };
}

/** The words each rung shows — title and the line under it. */
export const LADDER_WORDS: Record<Exclude<TasksLadder["kind"], "board" | "refusal">, { title: string; hint: string }> = {
  noWorkspace: { title: "No workspace open", hint: "Tasks belong to a workspace — open one first" },
  noTeam: { title: "No team here", hint: "A board belongs to a team — start one and its board appears" },
  loading: { title: "Loading…", hint: "" },
  empty: {
    title: "Nothing on the board yet",
    hint: `Put work here with ${NEW_TASK_LABEL}; agents read the board themselves — task.list, task.mine`,
  },
};
