import { describe, expect, it } from "vitest";
import { teamOnScreen } from "./teamOnScreen";
import { restoreView } from "./words";
import { INITIAL_SCREEN, initialScreen, queryOn, restoreConfirm, screenReducer, walksRows, wideView, type ScreenState } from "./screenState";
import { NO_QUERY } from "./queryView";

describe("screenState", () => {
  it("a restore runs only from its confirm, once, and the confirm shows only while there is one to offer", () => {
    const offer = restoreView({ kind: "damaged", backups: [] }, 0);
    const asked = screenReducer(INITIAL_SCREEN, { type: "askRestore" }, null);
    expect(restoreConfirm(asked.state, offer)).toBe(offer);
    expect(restoreConfirm(asked.state, null)).toBeNull();
    expect(restoreConfirm(INITIAL_SCREEN, offer)).toBeNull();
    expect(screenReducer(asked.state, { type: "cancelRestore" }, null)).toEqual({ state: INITIAL_SCREEN });
    const yes = screenReducer(asked.state, { type: "confirmRestore" }, null);
    expect(yes).toEqual({ state: INITIAL_SCREEN, restore: true });
    // A second yes — or one with no confirm up — runs nothing.
    expect(screenReducer(yes.state, { type: "confirmRestore" }, null).restore).toBeUndefined();
  });

  const open: ScreenState = { ...INITIAL_SCREEN, composing: true, wide: true, chosenTeam: "team-1" };

  it("a card click opens it, closing the form; the open card's click puts it away and narrows", () => {
    const opened = screenReducer(open, { type: "row", id: "task-1", open: null }, null);
    expect(opened.focus).toBe("task-1");
    expect(opened.state).toMatchObject({ composing: false, wide: true });
    const closed = screenReducer(opened.state, { type: "row", id: "task-1", open: "task-1" }, null);
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

  it("another team takes the open task with it; a group hovers only under a drag", () => {
    expect(screenReducer(open, { type: "team", id: "team-2" }, null)).toEqual({ state: { ...open, chosenTeam: "team-2", wide: false }, focus: null });
    expect(screenReducer(open, { type: "hover", status: "done", dragging: true }, null).state.hover).toBe("done");
    expect(screenReducer(open, { type: "hover", status: "done", dragging: false }, null).state.hover).toBeNull();
  });

  it("narrows by a label, per team: another team's board shows unnarrowed, however it came up", () => {
    const labelled = screenReducer(INITIAL_SCREEN, { type: "label", label: "ui" }, "team-1").state;
    expect(queryOn(labelled, "team-1")).toEqual({ label: "ui" });
    expect(queryOn(screenReducer(labelled, { type: "label", label: "ui" }, "team-1").state, "team-1").label).toBeNull();
    // A pick of another team, or a link that put its task on screen.
    expect(queryOn(screenReducer(labelled, { type: "team", id: "team-2" }, "team-1").state, "team-2")).toEqual(NO_QUERY);
    expect(queryOn(labelled, "team-2")).toEqual(NO_QUERY);
    // Back on the first team, its filter is still its own.
    expect(queryOn(labelled, "team-1").label).toBe("ui");
    // A filter set on the second team starts from nothing, not the first's.
    const there = screenReducer(labelled, { type: "label", label: "api" }, "team-2").state;
    expect(queryOn(there, "team-2")).toEqual({ label: "api" });
  });

  it("rests the history compact, and its heading toggles it whole, kept from task to task", () => {
    expect(INITIAL_SCREEN.activityOpen).toBe(false);
    const open = screenReducer(INITIAL_SCREEN, { type: "toggleActivity" }, null).state;
    expect(open.activityOpen).toBe(true);
    expect(screenReducer(open, { type: "row", id: "task-2", open: "task-1" }, null).state.activityOpen).toBe(true);
    expect(screenReducer(open, { type: "toggleActivity" }, null).state.activityOpen).toBe(false);
  });

  it("opens the form in an epic — picked for the new task — or on its own", () => {
    expect(screenReducer(INITIAL_SCREEN, { type: "compose", epic: "task-3" }, null).state).toMatchObject({ composing: true, composeEpic: "task-3" });
    const inEpic = screenReducer(INITIAL_SCREEN, { type: "compose", epic: "task-3" }, null).state;
    expect(screenReducer(inEpic, { type: "compose" }, null).state.composeEpic).toBeNull();
    expect(screenReducer(INITIAL_SCREEN, { type: "toggleCompose" }, null).state.composeEpic).toBeNull();
  });

  it("walks the list with J / K, never while the form is up", () => {
    expect(walksRows({ composing: false })).toBe(true);
    expect(walksRows({ composing: true })).toBe(false);
  });

  it("the team on screen when the person acts becomes their choice — putting a task away never moves the board", () => {
    // Opened by a link on team-2's task while the choice was elsewhere:
    // every way the task goes away keeps team-2, and so does every
    // delegated step (escape → narrow / cancelCompose / close,
    // toggleCompose → compose) — the pin must survive the delegation.
    const linked: ScreenState = { ...INITIAL_SCREEN, chosenTeam: null };
    const wideOpen = { ...linked, wide: true };
    const composingOpen = { ...linked, composing: true };
    const ways = [
      screenReducer(linked, { type: "close" }, "team-2"),
      screenReducer(linked, { type: "row", id: "task-9", open: "task-9" }, "team-2"),
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

  it("a dialog starts from the stage's open team", () => {
    expect(initialScreen("team-2")).toEqual({ ...INITIAL_SCREEN, chosenTeam: "team-2" });
    expect(initialScreen(null)).toEqual(INITIAL_SCREEN);
  });

  it("an explicit pick outranks the pin, and a board with no team pins nothing", () => {
    const chosen: ScreenState = { ...INITIAL_SCREEN, chosenTeam: "team-1" };
    expect(screenReducer(chosen, { type: "team", id: "team-3" }, "team-2").state.chosenTeam).toBe("team-3");
    expect(screenReducer(chosen, { type: "close" }, null).state.chosenTeam).toBe("team-1");
  });
});
