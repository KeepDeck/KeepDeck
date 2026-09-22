import { describe, expect, it } from "vitest";
import { TASK_CAPS } from "../../domain/tasks";
import { board, task } from "../../domain/tasks/testSupport";
import { boardView } from "./boardView";
import {
  CLICK_AFTER_DRAG_MS,
  DRAG_THRESHOLD_PX,
  IDLE,
  armCard,
  clickDisbelieved,
  dropStateOf,
  ghostBox,
  moveCard,
  releaseCard,
} from "./cardDrag";
import { EMPTY_COMPOSER, beginSend, composerCanSend, finishSend, typeDraft } from "./composer";
import { canCreateTask, canSendComment } from "./composerView";
import { DIALOG_WORDS, cardOf, escapeTarget, selectionAfterClick, teamControlView, toggledFold } from "./dialogState";
import { EMPTY_TASK_DRAFT, assigneeOf, taskInputOf } from "./formDraft";
import { INITIAL_SCREEN, initialScreen, screenReducer, wideView, type ScreenState } from "./screenState";
import { teamOnScreen } from "./teamOnScreen";
import { offWaitingHint, showTasksSocketHint } from "./settingsView";

const grip = { width: 200, offsetX: 20, offsetY: 10 };
const targets = new Set(["in-progress", "done"] as const);

describe("cardDrag", () => {
  it("a press is a click until it travels the threshold; then it is a drag with its targets, following the pointer", () => {
    const armed = armCard("task-1", 10, 10, grip);
    expect(moveCard(armed, 12, 12, () => targets)).toBe(armed);
    const dragging = moveCard(armed, 10 + DRAG_THRESHOLD_PX, 10, () => targets);
    expect(dragging).toMatchObject({ kind: "dragging", id: "task-1", x: 16, y: 10, targets });
    expect(moveCard(dragging, 100, 50, () => null)).toMatchObject({ kind: "dragging", x: 100, y: 50 });
    expect(ghostBox(dragging)).toEqual({ left: 16 - 20, top: 0, width: 200 });
    expect(ghostBox(armed)).toBeNull();
  });

  it("a card that vanished under the press cannot become a drag", () => {
    expect(moveCard(armCard("task-9", 0, 0, grip), 50, 50, () => null)).toBe(IDLE);
  });

  it("release over a target moves; over anything else, or from a mere press, nothing", () => {
    const dragging = moveCard(armCard("task-1", 0, 0, grip), 50, 50, () => targets);
    expect(releaseCard(dragging, "done")).toEqual({ state: IDLE, move: { id: "task-1", to: "done" }, dragged: true });
    expect(releaseCard(dragging, "review")).toEqual({ state: IDLE, move: null, dragged: true });
    expect(releaseCard(dragging, null)).toEqual({ state: IDLE, move: null, dragged: true });
    expect(releaseCard(armCard("task-1", 0, 0, grip), "done")).toEqual({ state: IDLE, move: null, dragged: false });
  });

  it("columns read their part in the drag; the click after a drag is disbelieved briefly", () => {
    const dragging = moveCard(armCard("task-1", 0, 0, grip), 50, 50, () => targets);
    expect(dropStateOf("done", dragging, null)).toBe("ok");
    expect(dropStateOf("done", dragging, "done")).toBe("over");
    expect(dropStateOf("review", dragging, "review")).toBe("no");
    expect(dropStateOf("done", IDLE, "done")).toBeNull();
    expect(clickDisbelieved(1_000, 1_000 + CLICK_AFTER_DRAG_MS - 1)).toBe(true);
    expect(clickDisbelieved(1_000, 1_000 + CLICK_AFTER_DRAG_MS)).toBe(false);
    expect(clickDisbelieved(null, 5)).toBe(false);
  });
});

describe("dialogState", () => {
  it("Escape peels the form, then the wide view, then the task, then the dialog", () => {
    expect(escapeTarget({ composing: true, wide: true, detailOpen: true })).toBe("form");
    expect(escapeTarget({ composing: false, wide: true, detailOpen: true })).toBe("wide");
    expect(escapeTarget({ composing: false, wide: false, detailOpen: true })).toBe("detail");
    expect(escapeTarget({ composing: false, wide: false, detailOpen: false })).toBe("dialog");
  });

  it("a click opens a card or puts the open one away; a fold press sets the opposite of what shows", () => {
    expect(selectionAfterClick(null, "task-1")).toBe("task-1");
    expect(selectionAfterClick("task-1", "task-1")).toBeNull();
    expect(selectionAfterClick("task-1", "task-2")).toBe("task-2");
    const b = board([task({ id: "task-1" }), task({ id: "task-2", status: "done" })]);
    const columns = boardView(b.tasks, b, { showCancelled: false, folds: new Map(), now: 0 });
    expect(toggledFold(columns, "done")).toBe(false); // folded by default → Show sets unfolded
    expect(toggledFold(columns, "todo")).toBe(true);
    expect(toggledFold(columns, "cancelled")).toBeNull();
    expect(cardOf(columns, "task-2")?.id).toBe("task-2");
    expect(cardOf(columns, "task-9")).toBeUndefined();
  });

  it("only a closed column offers Hide/Show", () => {
    const b = board([task({ id: "task-1" })]);
    const columns = boardView(b.tasks, b, { showCancelled: true, folds: new Map(), now: 0 });
    const foldable = columns.filter((column) => column.foldable).map((column) => column.status);
    expect(foldable).toEqual(["done", "cancelled"]);
  });

  it("the team control is a pick among several, the one team's name as a word, or nothing", () => {
    const teams = [
      { id: "team-1", name: "Tasks" },
      { id: "team-2", name: "Docs" },
    ];
    expect(teamControlView(teams, "team-2")).toEqual({
      kind: "pick",
      options: [
        { value: "team-1", label: "Tasks" },
        { value: "team-2", label: "Docs" },
      ],
      value: "team-2",
    });
    expect(teamControlView(teams, null)).toEqual({ kind: "none" });
    expect(teamControlView([teams[0]], "team-1")).toEqual({ kind: "word", name: "Tasks" });
    expect(teamControlView([], null)).toEqual({ kind: "none" });
  });

  it("says the bar's and the head's words by state", () => {
    expect(DIALOG_WORDS.cancelledFilter(false)).toBe("Show cancelled");
    expect(DIALOG_WORDS.cancelledFilter(true)).toBe("Hide cancelled");
    expect(DIALOG_WORDS.cancelledFilterHint("board")).toBeNull();
    expect(DIALOG_WORDS.cancelledFilterHint("queues")).toContain("show on the board");
    expect(DIALOG_WORDS.wide(false)).toBe("Expand");
    expect(DIALOG_WORDS.wide(true)).toBe("Collapse");
    expect(DIALOG_WORDS.fold(true)).toBe("Show");
    expect(DIALOG_WORDS.poolCaption(true)).toContain("anyone on the team");
  });
});

describe("screenState", () => {
  const open: ScreenState = { ...INITIAL_SCREEN, composing: true, wide: true, chosenTeam: "team-1" };

  it("a card click opens it, closing the form; the open card's click puts it away and narrows", () => {
    const opened = screenReducer(open, { type: "card", id: "task-1", open: null }, null);
    expect(opened.focus).toBe("task-1");
    expect(opened.state).toMatchObject({ composing: false, wide: true });
    const closed = screenReducer(opened.state, { type: "card", id: "task-1", open: "task-1" }, null);
    expect(closed.focus).toBeNull();
    expect(closed.state.wide).toBe(false);
  });

  it("composing puts the open task away; a created task opens with the form gone", () => {
    const composing = screenReducer({ ...open, composing: false }, { type: "compose" }, null);
    expect(composing).toEqual({ state: { ...open, composing: true, wide: false }, focus: null });
    expect(screenReducer(open, { type: "toggleCompose" }, null).state.composing).toBe(false);
    expect(screenReducer({ ...open, composing: false }, { type: "toggleCompose" }, null).state.composing).toBe(true);
    const created = screenReducer(open, { type: "created", id: "task-4" }, null);
    expect(created).toEqual({ state: { ...open, composing: false, wide: false }, focus: "task-4" });
  });

  it("wide is only with a task open, and only shows with one", () => {
    expect(screenReducer(INITIAL_SCREEN, { type: "toggleWide", detailOpen: false }, null).state.wide).toBe(false);
    expect(screenReducer(INITIAL_SCREEN, { type: "toggleWide", detailOpen: true }, null).state.wide).toBe(true);
    expect(screenReducer(open, { type: "toggleWide", detailOpen: true }, null).state.wide).toBe(false);
    expect(wideView(open, false)).toBe(false);
    expect(wideView(open, true)).toBe(true);
  });

  it("Escape peels one layer at a time and only the last one closes the dialog", () => {
    const form = screenReducer(open, { type: "escape", detailOpen: true }, null);
    expect(form).toEqual({ state: { ...open, composing: false } });
    const wide = screenReducer(form.state, { type: "escape", detailOpen: true }, null);
    expect(wide).toEqual({ state: { ...open, composing: false, wide: false } });
    const detail = screenReducer(wide.state, { type: "escape", detailOpen: true }, null);
    expect(detail).toEqual({ state: wide.state, focus: null });
    expect(screenReducer(detail.state, { type: "escape", detailOpen: false }, null)).toEqual({ state: detail.state, closeDialog: true });
  });

  it("another team takes the open task with it; a column hovers only under a drag", () => {
    expect(screenReducer(open, { type: "team", id: "team-2" }, null)).toEqual({ state: { ...open, chosenTeam: "team-2", wide: false }, focus: null });
    expect(screenReducer(open, { type: "hover", status: "done", dragging: true }, null).state.hover).toBe("done");
    expect(screenReducer(open, { type: "hover", status: "done", dragging: false }, null).state.hover).toBeNull();
  });

  it("the team on screen when the person acts becomes their choice — putting a task away never moves the board", () => {
    // Opened by a link on team-2's task while the choice was elsewhere:
    // every way the task goes away, direct or delegated, keeps team-2.
    const linked: ScreenState = { ...INITIAL_SCREEN, chosenTeam: null };
    const wideOpen = { ...linked, wide: true };
    const composingOpen = { ...linked, composing: true };
    const ways = [
      screenReducer(linked, { type: "close" }, "team-2"),
      screenReducer(linked, { type: "card", id: "task-9", open: "task-9" }, "team-2"),
      screenReducer(linked, { type: "compose" }, "team-2"),
      // Delegated: escape→narrow→… and toggleCompose→compose go through
      // the machine's own steps, and the pin must not be lost on the way.
      screenReducer(linked, { type: "escape", detailOpen: true }, "team-2"),
      screenReducer(wideOpen, { type: "escape", detailOpen: true }, "team-2"),
      screenReducer(composingOpen, { type: "escape", detailOpen: false }, "team-2"),
      screenReducer(linked, { type: "toggleCompose" }, "team-2"),
    ];
    for (const outcome of ways) expect(outcome.state.chosenTeam).toBe("team-2");
    expect(teamOnScreen(["team-1", "team-2"], ways[2].state.chosenTeam, null)).toBe("team-2");
  });

  it("a dialog starts from the stage's open team; two dialogs share no fold record", () => {
    expect(initialScreen("team-2")).toEqual({ ...INITIAL_SCREEN, chosenTeam: "team-2" });
    expect(initialScreen(null)).toEqual(INITIAL_SCREEN);
    expect(initialScreen(null).folds).not.toBe(initialScreen(null).folds);
  });

  it("an explicit pick outranks the pin, and a board with no team pins nothing", () => {
    const chosen: ScreenState = { ...INITIAL_SCREEN, chosenTeam: "team-1" };
    expect(screenReducer(chosen, { type: "team", id: "team-3" }, "team-2").state.chosenTeam).toBe("team-3");
    expect(screenReducer(chosen, { type: "close" }, null).state.chosenTeam).toBe("team-1");
  });

  it("folds, the filter and the mode are remembered as pressed", () => {
    const b = board([task({ id: "task-1" }), task({ id: "task-2", status: "done" })]);
    const columns = boardView(b.tasks, b, { showCancelled: false, folds: new Map(), now: 0 });
    const folded = screenReducer(INITIAL_SCREEN, { type: "fold", status: "done", columns }, null);
    expect(folded.state.folds.get("done")).toBe(false);
    expect(screenReducer(INITIAL_SCREEN, { type: "fold", status: "cancelled", columns }, null).state).toBe(INITIAL_SCREEN);
    expect(screenReducer(INITIAL_SCREEN, { type: "toggleCancelled" }, null).state.showCancelled).toBe(true);
    expect(screenReducer(INITIAL_SCREEN, { type: "mode", mode: "queues" }, null).state.mode).toBe("queues");
  });
});

describe("composer", () => {
  it("a send takes the draft as typed, and an accepted send clears only that text", () => {
    const typed = typeDraft(EMPTY_COMPOSER, "first");
    expect(composerCanSend(typed)).toBe(true);
    const begun = beginSend(typed)!;
    expect(begun.body).toBe("first");
    expect(composerCanSend(begun.state)).toBe(false);
    expect(beginSend(begun.state)).toBeNull();
    expect(finishSend(begun.state, true)).toEqual(EMPTY_COMPOSER);
  });

  it("text typed while a send is out is kept — accepted or refused", () => {
    const begun = beginSend(typeDraft(EMPTY_COMPOSER, "first"))!;
    const typedMeanwhile = typeDraft(begun.state, "first and more");
    expect(finishSend(typedMeanwhile, true)).toEqual({ draft: "first and more", sending: null });
    expect(finishSend(typedMeanwhile, false)).toEqual({ draft: "first and more", sending: null });
    expect(finishSend(begun.state, false)).toEqual({ draft: "first", sending: null });
    expect(beginSend(EMPTY_COMPOSER)).toBeNull();
  });
});

describe("formDraft", () => {
  it("an empty form is the domain's defaults; an empty assignee pick is the pool", () => {
    expect(EMPTY_TASK_DRAFT.priority).toBe("normal");
    expect(assigneeOf("")).toBeNull();
    expect(assigneeOf("impl-1")).toBe("impl-1");
    expect(taskInputOf({ ...EMPTY_TASK_DRAFT, title: "Draft", assignee: "" })).toEqual({
      title: "Draft",
      body: "",
      assignee: null,
      priority: "normal",
    });
    expect(taskInputOf({ ...EMPTY_TASK_DRAFT, title: "Draft", assignee: "impl-2", priority: "high" }).assignee).toBe("impl-2");
  });
});

describe("composer and form validity come from the domain", () => {
  it("a comment may be sent when the domain would accept it and nothing is in flight", () => {
    expect(canSendComment("  ", false)).toBe(false);
    expect(canSendComment("x", true)).toBe(false);
    expect(canSendComment("x", false)).toBe(true);
    expect(canSendComment("x".repeat(TASK_CAPS.commentMax + 1), false)).toBe(false);
  });

  it("a task may be created when the domain would accept its title", () => {
    expect(canCreateTask("")).toBe(false);
    expect(canCreateTask("  ")).toBe(false);
    expect(canCreateTask("x".repeat(TASK_CAPS.titleMax + 1))).toBe(false);
    expect(canCreateTask("Draft the skill")).toBe(true);
  });
});

describe("settingsView", () => {
  it("says the socket is down only while the feature is on and the socket is not", () => {
    expect(showTasksSocketHint(true, false)).toBe(true);
    expect(showTasksSocketHint(true, true)).toBe(false);
    expect(showTasksSocketHint(false, false)).toBe(false);
  });

  it("says why Off is waiting, and that it completes on its own — nothing when it is not", () => {
    expect(offWaitingHint("keepdeck's board — disk full")).toBe(
      "Off is waiting: keepdeck's board — disk full. The board keeps the changes and retries on its own; Off completes once they are saved.",
    );
    expect(offWaitingHint(null)).toBeNull();
  });
});
