/**
 * The dialog's own decisions, apart from the markup: what Escape peels,
 * what a click on a card does to the selection, what a fold toggle sets,
 * which card a ghost is, and the words the bar and the panel head say.
 */
import type { TaskStatus } from "../../domain/tasks";
import type { BoardColumnView } from "./boardView";
import type { TaskCardView } from "./taskCardView";

export type TasksMode = "board" | "queues";

export const MODE_CHOICES: readonly { value: TasksMode; label: string }[] = [
  { value: "board", label: "Board" },
  { value: "queues", label: "Queues" },
];

/**
 * What one Escape press takes away: the form when it is open, then the
 * wide view back to the board, then the open task, then the dialog.
 * Closing the whole dialog out from under a half-typed brief is the one
 * thing the key must never do.
 */
export function escapeTarget(state: {
  composing: boolean;
  wide: boolean;
  detailOpen: boolean;
}): "form" | "wide" | "detail" | "dialog" {
  if (state.composing) return "form";
  if (state.wide) return "wide";
  if (state.detailOpen) return "detail";
  return "dialog";
}

/** A click on a card: opens it, or puts it away when it is the open one. */
export function selectionAfterClick(open: string | null, clicked: string): string | null {
  return open === clicked ? null : clicked;
}

/** What a Hide/Show press sets for a closed column: the opposite of what
 * the column shows now — whichever way it got there. Null for a column
 * that is not on the board. */
export function toggledFold(columns: readonly BoardColumnView[], status: TaskStatus): boolean | null {
  const shown = columns.find((column) => column.status === status);
  return shown ? !shown.collapsed : null;
}

/** The card with `id`, wherever its column is — what a ghost is drawn from. */
export function cardOf(columns: readonly BoardColumnView[], id: string): TaskCardView | undefined {
  for (const column of columns) {
    const card = column.cards.find((candidate) => candidate.id === id);
    if (card) return card;
  }
  return undefined;
}

/** The words of the bar and the panel head, by state. */
export const DIALOG_WORDS = {
  cancelledFilter: (showCancelled: boolean) => (showCancelled ? "Hide cancelled" : "Show cancelled"),
  /** Why the filter is inert, or null where it applies. */
  cancelledFilterHint: (mode: TasksMode) => (mode === "board" ? null : "Cancelled tasks show on the board"),
  wide: (wide: boolean) => (wide ? "Collapse" : "Expand"),
  fold: (collapsed: boolean) => (collapsed ? "Show" : "Hide"),
  poolCaption: (isPool: boolean) => (isPool ? "Next up — anyone on the team can take it" : "Next up"),
} as const;
