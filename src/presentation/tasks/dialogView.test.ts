import { describe, expect, it } from "vitest";
import { board, task } from "../../domain/tasks/testSupport";
import { QUERY_WORDS } from "./queryView";
import { rowInFlight, taskRowView, type TaskRowView } from "./taskRowView";
import { IDLE, armRow, moveRow } from "./rowDrag";
import { tasksDialogView } from "./dialogView";
import { LADDER_WORDS, type TasksLadder } from "./ladderView";

const b = board([task({ id: "task-1" })]);
const TEAMS = [
  { id: "team-1", name: "api" },
  { id: "team-2", name: "web" },
];
const base = {
  ladder: { kind: "board" } as TasksLadder,
  drag: IDLE,
  inFlight: null as TaskRowView | null,
  teams: TEAMS,
  teamId: "team-1" as string | null,
  composing: false,
  detailOpen: false,
  wide: false,
  nothingFound: false,
};
const view = (over: Partial<typeof base> = {}) => tasksDialogView({ ...base, ...over });

describe("tasksDialogView", () => {
  it("over a board: the toolbar, the team pick, the list, nothing open", () => {
    expect(view()).toEqual({
      className: "form tasks",
      toolbar: true,
      team: { kind: "pick", options: [{ value: "team-1", label: "api" }, { value: "team-2", label: "web" }], value: "team-1" },
      newTaskDisabled: false,
      body: { kind: "stage", main: { kind: "list" } },
      panel: null,
      headInert: false,
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
    // Under a panel the head is out of reach — no Tab stop nobody can see.
    expect(view({ detailOpen: true }).headInert).toBe(true);
    expect(view({ composing: true }).headInert).toBe(true);
    expect(view().headInert).toBe(false);
    expect(view({ composing: true, detailOpen: true }).panel).toBe("form");
    expect(view({ detailOpen: true }).panel).toBe("detail");
    expect(view({ teamId: null }).newTaskDisabled).toBe(true);
  });

  it("says no task matches when the filter lets none through", () => {
    expect(view({ nothingFound: true }).body).toEqual({ kind: "stage", main: { kind: "empty", ...QUERY_WORDS.nothing } });
    expect(view({ nothingFound: true }).toolbar).toBe(true);
  });

  it("a row in flight is drawn as a ghost under its grip and dims the board; a mere press draws nothing", () => {
    const grip = { width: 200, offsetX: 20, offsetY: 10 };
    const armed = armRow("task-1", 0, 0, grip);
    expect(view({ drag: armed })).toMatchObject({ className: "form tasks", ghost: null });
    const dragging = moveRow(armed, 50, 50, () => new Set(["done" as const]));
    const flying = view({ drag: dragging, inFlight: rowInFlight(dragging, b, "team-1", 0) });
    expect(flying.className).toBe("form tasks tasks--dragging");
    expect(flying.ghost).toEqual({ box: { left: 30, top: 40, width: 200 }, line: taskRowView(b.tasks[0], b, 0) });
    // A ghost needs both its place and its row: the row gone mid-drag, or no drag, draws none.
    expect(view({ drag: dragging, inFlight: null }).ghost).toBeNull();
    expect(view({ drag: armed, inFlight: rowInFlight(dragging, b, "team-1", 0) }).ghost).toBeNull();
    expect(rowInFlight(dragging, null, "team-1", 0)).toBeNull();
  });
});
