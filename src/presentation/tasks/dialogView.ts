/**
 * The Tasks dialog as one view: what its frame shows for the state it is
 * in — the toolbar or not, the body's placeholder or the stage, which
 * panel is open, the card in flight. The component maps these fields and
 * decides nothing; every choice below was once a branch in its JSX.
 */
import { ghostBox, type DragState } from "./cardDrag";
import { teamControlView } from "./dialogState";
import { LADDER_WORDS, type TasksLadder } from "./ladderView";
import type { TaskCardView } from "./taskCardView";
import { QUERY_WORDS } from "./queryView";
import { VIEW_WORDS } from "./words";
import { TASKS_VIEWS } from "../../domain/settings";
import type { TrackerView } from "./screenState";

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
  | { kind: "stage"; main: { kind: "columns" } | { kind: "list" } | { kind: "empty"; title: string; hint: string } | null };

export interface TasksDialogView {
  className: string;
  /** The toolbar (the team, + Task) — only over a board to act on. */
  toolbar: boolean;
  team: ReturnType<typeof teamControlView>;
  /** + Task needs a team for the task to go to. */
  newTaskDisabled: boolean;
  /** List and Board — the two views, as the toolbar's choice row. */
  viewChoice: { ariaLabel: string; value: TrackerView; options: { value: TrackerView; label: string }[] };
  body: DialogBody;
  /** The panel over the dialog: the new-task form outranks an open task. */
  panel: "form" | "detail" | null;
  /** The dialog's head lies under the panel: out of reach while it does —
   * no Tab stop on a control nobody can see. Escape still peels the panel,
   * then closes the dialog. */
  headInert: boolean;
  /** The card in flight, where it is drawn — null while nothing is. */
  /** The task in flight, drawn as the view it left draws it: a card over
   * the board, a row over the list. */
  ghost: {
    box: { left: number; top: number; width: number };
    shape: "card" | "row";
    className: string;
    card: TaskCardView;
  } | null;
}

export function tasksDialogView(input: {
  ladder: TasksLadder;
  drag: DragState;
  /** The task in flight's card (`cardInFlight`). */
  inFlight: TaskCardView | null;
  teams: readonly { id: string; name: string }[];
  teamId: string | null;
  composing: boolean;
  detailOpen: boolean;
  wide: boolean;
  view: TrackerView;
  /** The filter lets no task through (`findsNothing`). */
  nothingFound: boolean;
}): TasksDialogView {
  const { ladder, drag } = input;
  const staged = ladder.kind === "board" || ladder.kind === "empty";
  const box = ghostBox(drag);
  const card = input.inFlight;
  const panel = input.composing ? "form" : input.detailOpen ? "detail" : null;
  return {
    className: drag.kind === "dragging" ? "form tasks tasks--dragging" : "form tasks",
    toolbar: staged,
    team: teamControlView(input.teams, input.teamId),
    newTaskDisabled: input.teamId === null,
    viewChoice: {
      ariaLabel: VIEW_WORDS.choice,
      value: input.view,
      options: TASKS_VIEWS.map((view) => ({ value: view, label: VIEW_WORDS.label[view] })),
    },
    body: staged ? { kind: "stage", main: stageMain(ladder, input.wide, input.view, input.nothingFound) } : placeholder(ladder),
    panel,
    headInert: staged && panel !== null,
    ghost: box && card ? ghostOf(box, input.view === "list" ? "row" : "card", card) : null,
  };
}

function stageMain(
  ladder: TasksLadder,
  wide: boolean,
  view: TrackerView,
  nothingFound: boolean,
): Extract<DialogBody, { kind: "stage" }>["main"] {
  // Wide: the open task fills the stage and the view is put away — not
  // hidden under it, gone until the person comes back.
  if (wide) return null;
  if (ladder.kind === "empty") return { kind: "empty", ...LADDER_WORDS.empty };
  if (nothingFound) return { kind: "empty", ...QUERY_WORDS.nothing };
  return view === "list" ? { kind: "list" } : { kind: "columns" };
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

function ghostOf(
  box: { left: number; top: number; width: number },
  shape: "card" | "row",
  card: TaskCardView,
): NonNullable<TasksDialogView["ghost"]> {
  return { box, shape, className: `tasks__ghost tasks__ghost--${shape}`, card };
}
