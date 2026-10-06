/**
 * The Tasks dialog as one view: what its frame shows for the state it is
 * in — the toolbar or not, the body's placeholder or the stage, which
 * panel is open, the task in flight. The component maps these fields and
 * decides nothing; every choice below was once a branch in its JSX.
 */
import { ghostBox, type DragState } from "./rowDrag";
import { teamControlView } from "./dialogState";
import { LADDER_WORDS, type TasksLadder } from "./ladderView";
import type { TaskRowView } from "./taskRowView";
import { QUERY_WORDS } from "./queryView";

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
  | { kind: "stage"; main: { kind: "list" } | { kind: "empty"; title: string; hint: string } | null };

export interface TasksDialogView {
  className: string;
  /** The toolbar (the team, + Task) — only over a board to act on. */
  toolbar: boolean;
  team: ReturnType<typeof teamControlView>;
  /** + Task needs a team for the task to go to. */
  newTaskDisabled: boolean;
  body: DialogBody;
  /** The panel over the dialog: the new-task form outranks an open task. */
  panel: "form" | "detail" | null;
  /** The dialog's head lies under the panel: out of reach while it does —
   * no Tab stop on a control nobody can see. Escape still peels the panel,
   * then closes the dialog. */
  headInert: boolean;
  /** The task in flight, drawn as its row, where it is held — null while
   * nothing is. */
  ghost: {
    box: { left: number; top: number; width: number };
    line: TaskRowView;
  } | null;
}

export function tasksDialogView(input: {
  ladder: TasksLadder;
  drag: DragState;
  /** The task in flight's row (`rowInFlight`). */
  inFlight: TaskRowView | null;
  teams: readonly { id: string; name: string }[];
  teamId: string | null;
  composing: boolean;
  detailOpen: boolean;
  wide: boolean;
  /** The filter lets no task through (`findsNothing`). */
  nothingFound: boolean;
}): TasksDialogView {
  const { ladder, drag } = input;
  const staged = ladder.kind === "board" || ladder.kind === "empty";
  const box = ghostBox(drag);
  const line = input.inFlight;
  const panel = input.composing ? "form" : input.detailOpen ? "detail" : null;
  return {
    className: drag.kind === "dragging" ? "form tasks tasks--dragging" : "form tasks",
    toolbar: staged,
    team: teamControlView(input.teams, input.teamId),
    newTaskDisabled: input.teamId === null,
    body: staged ? { kind: "stage", main: stageMain(ladder, input.wide, input.nothingFound) } : placeholder(ladder),
    panel,
    headInert: staged && panel !== null,
    ghost: box && line ? { box, line } : null,
  };
}

function stageMain(
  ladder: TasksLadder,
  wide: boolean,
  nothingFound: boolean,
): Extract<DialogBody, { kind: "stage" }>["main"] {
  // Wide: the open task fills the stage and the view is put away — not
  // hidden under it, gone until the person comes back.
  if (wide) return null;
  if (ladder.kind === "empty") return { kind: "empty", ...LADDER_WORDS.empty };
  if (nothingFound) return { kind: "empty", ...QUERY_WORDS.nothing };
  return { kind: "list" };
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
