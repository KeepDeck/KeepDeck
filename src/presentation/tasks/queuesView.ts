import {
  currentOf,
  queueOf,
  tasksOfTeam,
  type TaskBoard,
} from "../../domain/tasks";
import { taskCardView, type TaskCardView } from "./taskCardView";
import { POOL_LABEL } from "./words";

/** One member's lane — the load view: what they are on, what waits. */
export interface QueueLaneView {
  key: string;
  name: string;
  isPool: boolean;
  /** Everything the member has in progress — all of it. The domain sets
   * no limit of one, and the person may move tasks freely, so a lane that
   * showed one card hid the load this view exists to show. */
  current: TaskCardView[];
  queued: TaskCardView[];
  /** `1 queued`, `2 in progress · 1 queued`, `2 queued · unassigned`. */
  summary: string;
  /** Where the current card would be, when there is none. */
  idleText: string | null;
  /** Under an empty queue: why it is empty, when the board knows. */
  queueEmptyText: string | null;
}

/**
 * A lane per role on the roster, then the pool. The roster comes from
 * the deck, so an idle member has a lane too — an empty lane IS the fact
 * the view exists to show.
 */
export function queuesView(
  board: TaskBoard,
  teamId: string,
  roster: readonly string[],
  now: number,
): QueueLaneView[] {
  const team = tasksOfTeam(board, teamId);
  const lanes = roster.map((role): QueueLaneView => {
    const current = currentOf(board, teamId, role);
    const queued = queueOf(board, teamId, role);
    const inReview = team.filter((task) => task.assignee === role && task.status === "review");
    return {
      key: role,
      name: role,
      isPool: false,
      current: current.map((task) => taskCardView(task, board, now)),
      queued: queued.map((task) => taskCardView(task, board, now)),
      summary: current.length > 1 ? `${current.length} in progress · ${queued.length} queued` : `${queued.length} queued`,
      idleText: current.length > 0 ? null : queued.length > 0 ? `Nothing in progress · ${queued.length} queued` : "Nothing in progress",
      queueEmptyText:
        queued.length > 0
          ? null
          : inReview.length > 0
            ? `Nothing queued — ${inReview.map((task) => task.id).join(", ")} waits in review`
            : "Nothing queued",
    };
  });
  const pool = queueOf(board, teamId, null);
  lanes.push({
    key: POOL_LABEL,
    name: POOL_LABEL,
    isPool: true,
    current: [],
    queued: pool.map((task) => taskCardView(task, board, now)),
    summary: `${pool.length} queued · unassigned`,
    idleText: null,
    queueEmptyText: pool.length === 0 ? "Nothing in the pool" : null,
  });
  return lanes;
}
