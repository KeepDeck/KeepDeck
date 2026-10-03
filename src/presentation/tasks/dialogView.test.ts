import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import { boardView } from "./boardView";
import type { TrackerView } from "./screenState";
import { NO_QUERY, QUERY_WORDS } from "./queryView";
import { cardInFlight, type TaskCardView } from "./taskCardView";
import { IDLE, armCard, moveCard } from "./cardDrag";
import { tasksDialogView } from "./dialogView";
import { LADDER_WORDS, type TasksLadder } from "./ladderView";

const b = board([task({ id: "task-1" })]);
const columns = boardView(b.tasks, b, 0, NO_QUERY);
const TEAMS = [
  { id: "team-1", name: "api" },
  { id: "team-2", name: "web" },
];
const base = {
  ladder: { kind: "board" } as TasksLadder,
  drag: IDLE,
  inFlight: null as TaskCardView | null,
  teams: TEAMS,
  teamId: "team-1" as string | null,
  composing: false,
  detailOpen: false,
  wide: false,
  view: "board" as TrackerView,
  nothingFound: false,
};
const view = (over: Partial<typeof base> = {}) => tasksDialogView({ ...base, ...over });

describe("tasksDialogView", () => {
  it("over a board: the toolbar, the team pick, the columns, nothing open", () => {
    expect(view()).toEqual({
      className: "form tasks",
      toolbar: true,
      team: { kind: "pick", options: [{ value: "team-1", label: "api" }, { value: "team-2", label: "web" }], value: "team-1" },
      newTaskDisabled: false,
      viewChoice: {
        ariaLabel: "View",
        value: "board",
        options: [
          { value: "list", label: "List" },
          { value: "board", label: "Board" },
        ],
      },
      body: { kind: "stage", main: { kind: "columns" } },
      panel: null,
      ghost: null,
    });
  });

  it("an empty board keeps the toolbar and says so on the stage; a wide task puts the board away", () => {
    expect(view({ ladder: { kind: "empty" } }).body).toEqual({ kind: "stage", main: { kind: "empty", ...LADDER_WORDS.empty } });
    expect(view({ ladder: { kind: "empty" } }).toolbar).toBe(true);
    expect(view({ wide: true }).body).toEqual({ kind: "stage", main: null });
  });

  it("a rung with no board shows its words and no toolbar; the backend's refusal is read out and selectable", () => {
    const loading = view({ ladder: { kind: "loading" } });
    expect(loading.toolbar).toBe(false);
    // "Loading…" has no hint line: an empty hint is none.
    expect(loading.body).toMatchObject({ kind: "placeholder", title: "Loading…", hint: null, titleRole: undefined });
    expect(view({ ladder: { kind: "refusal", message: "board.json is not JSON" } }).body).toEqual({
      kind: "placeholder",
      title: "board.json is not JSON",
      hint: null,
      titleClassName: "tasks__placeholder-title kd-selectable",
      titleRole: "alert",
    });
  });

  it("the form outranks an open task for the panel; + Task needs a team", () => {
    expect(view({ composing: true, detailOpen: true }).panel).toBe("form");
    expect(view({ detailOpen: true }).panel).toBe("detail");
    expect(view({ teamId: null }).newTaskDisabled).toBe(true);
  });

  it("a row in flight from the list is drawn as a row, never as the board's card", () => {
    const drag = { kind: "dragging", id: "task-1", x: 40, y: 50, grip: { width: 600, offsetX: 10, offsetY: 10 }, targets: new Set<never>() } as const;
    const flying = view({ view: "list", drag, inFlight: cardInFlight(drag, b, 0) });
    expect(flying.ghost).toMatchObject({ shape: "row", className: "tasks__ghost tasks__ghost--row", box: { left: 30, top: 40, width: 600 } });
    expect(flying.ghost?.card.id).toBe("task-1");
  });

  it("says no task matches when the filter lets none through", () => {
    expect(view({ nothingFound: true }).body).toEqual({ kind: "stage", main: { kind: "empty", ...QUERY_WORDS.nothing } });
    expect(view({ nothingFound: true }).toolbar).toBe(true);
  });

  it("a card in flight is drawn as a ghost and dims the board; a mere press draws nothing", () => {
    const grip = { width: 200, offsetX: 20, offsetY: 10 };
    const armed = armCard("task-1", 0, 0, grip);
    expect(view({ drag: armed })).toMatchObject({ className: "form tasks", ghost: null });
    const dragging = moveCard(armed, 50, 50, () => new Set(["done" as const]));
    const flying = view({ drag: dragging, inFlight: cardInFlight(dragging, b, 0) });
    expect(flying.className).toBe("form tasks tasks--dragging");
    expect(flying.ghost).toEqual({ box: { left: 30, top: 40, width: 200 }, shape: "card", className: "tasks__ghost tasks__ghost--card", card: columns[0].cards.find((c) => c.id === "task-1") ?? columns.flatMap((c) => c.cards)[0] });
  });
});
