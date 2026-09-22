/**
 * The dialog's own decisions, apart from the markup: what Escape peels,
 * what a click on a card does to the selection, which card a ghost is, and the words the bar and the panel head say.
 */
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

/** The card with `id`, wherever its column is — what a ghost is drawn from. */
export function cardOf(columns: readonly BoardColumnView[], id: string): TaskCardView | undefined {
  for (const column of columns) {
    const card = column.cards.find((candidate) => candidate.id === id);
    if (card) return card;
  }
  return undefined;
}

/** What the bar shows for the team: a pick among several, the one
 * team's name as a word, or nothing on a workspace with none. */
export function teamControlView(
  teams: readonly { id: string; name: string }[],
  teamId: string | null,
): { kind: "pick"; options: { value: string; label: string }[]; value: string } | { kind: "word"; name: string } | { kind: "none" } {
  if (teams.length > 1 && teamId !== null) {
    return { kind: "pick", options: teams.map((team) => ({ value: team.id, label: team.name })), value: teamId };
  }
  if (teams.length === 1) return { kind: "word", name: teams[0].name };
  return { kind: "none" };
}

/** The words of the bar and the panel head, by state. */
export const DIALOG_WORDS = {
  cancelledFilter: (showCancelled: boolean) => (showCancelled ? "Hide cancelled" : "Show cancelled"),
  /** Why the filter is inert, or null where it applies. */
  cancelledFilterHint: (mode: TasksMode) => (mode === "board" ? null : "Cancelled tasks show on the board"),
  wide: (wide: boolean) => (wide ? "Collapse" : "Expand"),
  poolCaption: (isPool: boolean) => (isPool ? "Next up — anyone on the team can take it" : "Next up"),
} as const;
