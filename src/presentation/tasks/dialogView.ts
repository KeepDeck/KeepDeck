/**
 * The Tasks dialog as one view: what its frame shows for the state it is
 * in — the toolbar or not, the body's placeholder or the stage, which
 * panel is open, the card in flight. The component maps these fields and
 * decides nothing; every choice below was once a branch in its JSX.
 */
import type { BoardColumnView } from "./boardView";
import { ghostBox, type DragState } from "./cardDrag";
import { cardOf, teamControlView } from "./dialogState";
import { LADDER_WORDS, type TasksLadder } from "./ladderView";
import type { TaskCardView } from "./taskCardView";

/** What the body shows under the head. */
export type DialogBody =
  /** A rung with no board to draw: the words for it. The backend's own
   * refusal is read out (`role`) and selectable (its class). */
  | {
      kind: "placeholder";
      title: string;
      hint: string | null;
      titleClassName: string;
      titleRole: "alert" | undefined;
    }
  /** The board's stage. `main` is null while the open task fills it. */
  | { kind: "stage"; main: { kind: "columns" } | { kind: "empty"; title: string; hint: string } | null };

export interface TasksDialogView {
  className: string;
  /** The toolbar (the team, + Task) — only over a board to act on. */
  toolbar: boolean;
  team: ReturnType<typeof teamControlView>;
  /** + Task needs a team for the task to go to. */
  newTaskDisabled: boolean;
  body: DialogBody;
  /** The panel over the stage: the new-task form outranks an open task. */
  panel: "form" | "detail" | null;
  /** The card in flight, where it is drawn — null while nothing is. */
  ghost: { box: { left: number; top: number; width: number }; card: TaskCardView } | null;
}

export function tasksDialogView(input: {
  ladder: TasksLadder;
  drag: DragState;
  columns: readonly BoardColumnView[];
  teams: readonly { id: string; name: string }[];
  teamId: string | null;
  composing: boolean;
  detailOpen: boolean;
  wide: boolean;
}): TasksDialogView {
  const { ladder, drag } = input;
  const staged = ladder.kind === "board" || ladder.kind === "empty";
  const box = ghostBox(drag);
  const card = drag.kind === "dragging" ? cardOf(input.columns, drag.id) : undefined;
  return {
    className: drag.kind === "dragging" ? "form tasks tasks--dragging" : "form tasks",
    toolbar: staged,
    team: teamControlView(input.teams, input.teamId),
    newTaskDisabled: input.teamId === null,
    body: staged ? { kind: "stage", main: stageMain(ladder, input.wide) } : placeholder(ladder),
    panel: input.composing ? "form" : input.detailOpen ? "detail" : null,
    ghost: box && card ? { box, card } : null,
  };
}

function stageMain(ladder: TasksLadder, wide: boolean): Extract<DialogBody, { kind: "stage" }>["main"] {
  // Wide: the open task fills the stage and the board is put away — not
  // hidden under it, gone until the person comes back.
  if (wide) return null;
  return ladder.kind === "empty" ? { kind: "empty", ...LADDER_WORDS.empty } : { kind: "columns" };
}

function placeholder(ladder: Exclude<TasksLadder, { kind: "board" | "empty" }>): DialogBody {
  if (ladder.kind === "refusal") {
    return {
      kind: "placeholder",
      title: ladder.message,
      hint: null,
      titleClassName: "tasks__placeholder-title kd-selectable",
      titleRole: "alert",
    };
  }
  const words = LADDER_WORDS[ladder.kind];
  return {
    kind: "placeholder",
    title: words.title,
    hint: words.hint || null,
    titleClassName: "tasks__placeholder-title",
    titleRole: undefined,
  };
}
