// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTasksService, type TasksService } from "../../app/tasks";
import type { RestoreChoice } from "../../app/tasks/tasksService";
import { fakeStore, teamedWorkspaces } from "../../app/tasks/testSupport";
import { USER_ACTOR, agentActor, blockerIdsOf, encodeBoard } from "../../domain/tasks";
import { board as boardOf, task as taskOf } from "../../domain/tasks/testSupport";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { TasksDialog } from "./TasksDialog";
import type { TasksAccess } from "./useTasksBoard";
import type { Workspace } from "../../domain/deck";
import { DEFAULT_SETTINGS, type Settings } from "../../domain/settings";
import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";

// The registry's reads are a port the dialog is handed; the open-by-identity
// ladder is doubled at its IPC edge so a click on an attachment is observed.
vi.mock("../../app/artifacts/entryPoints", () => ({ openArtifactByRef: vi.fn(async () => "http://x") }));
import { openArtifactByRef } from "../../app/artifacts/entryPoints";

const registry: { rows: { id: string; title: string }[] } = { rows: [] };
const artifactReads: ArtifactsRegistryReadPort = {
  list: async () => registry.rows.map((row) => ({ ...row, versionCount: 1, updatedAt: 0, generation: "g" })),
  versions: async () => [],
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The settings owner as a live in-memory store: the dialog reads the
// list's folds from it and writes them back on a toggle.
const settingsStore = vi.hoisted(() => ({
  current: null as Settings | null,
  listeners: new Set<() => void>(),
}));
vi.mock("../../app/settingsManager", () => ({
  getSettings: () => settingsStore.current,
  subscribeSettings: (listener: () => void) => {
    settingsStore.listeners.add(listener);
    return () => settingsStore.listeners.delete(listener);
  },
  updateSettings: (patch: Partial<Settings>) => {
    settingsStore.current = { ...settingsStore.current!, ...patch };
    for (const listener of settingsStore.listeners) listener();
  },
}));

/** The owner as the runtime hands it out — here a fixed service, or none. */
function access(service: TasksService | null): TasksAccess {
  return { current: () => service, subscribe: () => () => {} };
}

const flush = () => act(async () => {});

let host: HTMLDivElement;
let root: Root;
let focus: string | null;
/** The team the stage has open, as App hands it to the dialog. */
let stageTeam: string | null;
const onFocus = (id: string | null) => {
  focus = id;
};

/** The list and the open task's card are windowed lists: happy-dom lays
 * nothing out, so the browser's geometry is imitated — the list 600px tall
 * and 900 wide, a row 34; the open card tall enough to draw every row. */
let restoreViewport: () => void;
let restoreCard: () => void;

beforeEach(() => {
  settingsStore.current = DEFAULT_SETTINGS;
  installResizeObserver();
  restoreViewport = pinListViewport("tasks__list", 600, 900, 34);
  restoreCard = pinListViewport("tasks__detail-body", 4000, 440, 40);
  document.body.innerHTML = "";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  focus = null;
  stageTeam = null;
});
afterEach(() => {
  act(() => root.unmount());
  restoreCard();
  restoreViewport();
});

const text = () => document.body.textContent ?? "";
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const button = (label: string) => {
  // By its words, or — an icon button — by its accessible name.
  const found = buttons().find((b) => b.textContent?.trim() === label || (b.textContent?.trim() === "" && b.getAttribute("aria-label") === label));
  if (!found) throw new Error(`no button "${label}" among ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
};
const teamPicked = () => document.querySelector('button[aria-label="Team"] .dropdown__label')?.textContent;
/** Each shown row's own control — what a click opens. */
const rowOpens = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__row .tasks__row-open"));
const rowTitles = () => Array.from(document.querySelectorAll(".tasks__list .tasks__row-title")).map((t) => t.textContent);

function mount(service: TasksService | null, initial = teamedWorkspaces()[0], strict = false) {
  let workspace = initial;
  const render = (next?: Workspace) => {
    if (next) workspace = next;
    const dialog = createElement(TasksDialog, {
      tasks: access(service),
      artifactReads,
      workspace,
      stageTeam,
      focus,
      onFocus: (id: string | null) => {
        onFocus(id);
        render();
      },
      onClose: vi.fn(),
    });
    return act(() => root.render(strict ? createElement(StrictMode, null, dialog) : dialog));
  };
  return render;
}

/** A palette row by its words. */
function paletteOption(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".palette__item")).find(
    (row) => row.querySelector(".palette__label")?.textContent === label,
  )!;
}

async function seeded() {
  const workspaces = teamedWorkspaces();
  const service = createTasksService({ workspaces: () => workspaces, store: fakeStore().port, now: () => 1_000 });
  await service.create("ws-1", { teamId: "team-1", title: "Draft the skill", assignee: "impl-1" }, agentActor("lead", "team-1"));
  await service.create("ws-1", { teamId: "team-1", title: "Pooled work" }, USER_ACTOR);
  return { service, workspaces };
}

describe("TasksDialog", () => {
  it("offers a damaged database's restore, and restores only once the person confirms", async () => {
    const workspaces = teamedWorkspaces();
    const store = fakeStore();
    const restored: RestoreChoice[] = [];
    const takenAt = Date.now();
    const service = createTasksService({
      workspaces: () => workspaces,
      store: { ...store.port, recovery: () => ({ kind: "damaged", backups: [takenAt] }), restore: async (choice) => void restored.push(choice) },
      now: () => 1_000,
    });
    const render = mount(service);
    render();
    await flush();
    const offer = Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__restore button"))[0];
    expect(offer.textContent).toBe("Restore the backup from now");
    act(() => offer.click());
    await flush();
    // Asked first: nothing restored yet.
    expect(restored).toEqual([]);
    expect(document.querySelector(".confirm__title")?.textContent).toBe("Restore the task database?");
    const yes = Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm__actions button")).find((b) => b.textContent === "Restore")!;
    act(() => yes.click());
    await flush();
    expect(restored).toEqual([{ kind: "backup", at: takenAt }]);
  });

  it("shows the board as a list, opens a task on click, and moves it with the status picker", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    expect(text()).toContain("To do");
    expect(rowTitles()).toEqual(["Draft the skill", "Pooled work"]);
    // One view: no switch between views in the toolbar.
    expect(document.querySelector('[role="radiogroup"][aria-label="View"]')).toBeNull();

    act(() => rowOpens()[0].click());
    await flush();
    expect(focus).toBe("task-1");
    expect(text()).toContain("by lead");

    // The status picker offers the person every status, in board order.
    const statusPicker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Status"]')!;
    const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const EVERY = ["Blocked", "Backlog", "To do", "In progress", "Review", "Done", "Cancelled"];
    act(() => statusPicker().click());
    await flush();
    expect(options().map((o) => o.textContent)).toEqual(EVERY);
    act(() => options().find((o) => o.textContent === "In progress")!.click());
    await flush();
    render();
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].status).toBe("in-progress");
    act(() => statusPicker().click());
    await flush();
    expect(options().map((o) => o.textContent)).toEqual(EVERY);
  });

  it("narrows to a label clicked on a row — its chip clears it; there is no Blocked filter", async () => {
    const { service } = await seeded();
    await service.apply("ws-1", "task-2", [{ kind: "labels", to: ["copy"] }], USER_ACTOR);
    const render = mount(service);
    render();
    await flush();
    const chip = () => document.querySelector<HTMLButtonElement>('button[aria-label="Show every label, not only copy"]');
    expect(buttons().some((b) => b.textContent?.trim() === "Blocked")).toBe(false);
    expect(chip()).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>(".tasks__row .kd-tag:not(.kd-tag--outline)")!.click());
    await flush();
    expect(rowTitles()).toEqual(["Pooled work"]);
    expect(chip()?.textContent).toBe("label: copy ✕");
    act(() => chip()!.click());
    await flush();
    expect(rowTitles()).toEqual(["Draft the skill", "Pooled work"]);
    expect(chip()).toBeNull();
  });

  it("groups the list by status, folds a group, opens a task from a row, and walks with J / K", async () => {
    const { service } = await seeded();
    await service.apply("ws-1", "task-2", [{ kind: "status", to: "cancelled" }], USER_ACTOR);
    const render = mount(service);
    render();
    await flush();
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".tasks__row"));
    const open = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".tasks__row-open")!;
    const headings = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__list-item .tasks__group")).map((h) => h.textContent);
    // All seven groups stand; the parked and the closed work open folded
    // — Cancelled is a heading with its count, no rows.
    expect(headings()).toEqual(["Blocked0", "Backlog0", "To do1", "In progress0", "Review0", "Done0", "Cancelled1"]);
    expect(rows().map((r) => r.querySelector(".tasks__row-title")?.textContent)).toEqual(["Draft the skill"]);
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__list-item .tasks__group"))[6].click());
    await flush();
    expect(rows().map((r) => r.querySelector(".tasks__row-title")?.textContent)).toEqual(["Draft the skill", "Pooled work"]);

    // A row opens its task over the list; the list stays where it is.
    act(() => open(rows()[0]).click());
    await flush();
    render();
    await flush();
    expect(focus).toBe("task-1");
    expect(text()).toContain("by lead");
    expect(open(rows()[0]).getAttribute("aria-pressed")).toBe("true");
    // J walks to the next task, the card following; not while typing.
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })));
    await flush();
    render();
    await flush();
    expect(focus).toBe("task-2");
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => void composer.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true })));
    await flush();
    expect(focus).toBe("task-2");
  });

  it("labels the open task from its card and takes a label off — the field keeps a refused one", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    render();
    await flush();
    const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Add a label"]')!;
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(field(), value);
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
    const submit = async () => {
      await act(async () => void field().form!.requestSubmit());
      await flush();
    };
    const labelsOnTask = () => {
      const state = service.peek("ws-1");
      return state?.kind === "ready" ? state.board.tasks[0].labels : null;
    };

    type("Copy Edit");
    await submit();
    expect(labelsOnTask()).toEqual(["copy-edit"]);
    expect(field().value).toBe("");

    type("a/b");
    await submit();
    expect(labelsOnTask()).toEqual(["copy-edit"]);
    expect(field().value).toBe("a/b");
    expect(text()).toContain("is not a label");

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Remove copy-edit"]')!.click());
    await flush();
    expect(labelsOnTask()).toEqual([]);
  });

  it("keeps the list's folds across closing and opening the dialog — they are settings too", async () => {
    const restoreList = pinListViewport("tasks__list", 600, 900, 34);
    try {
      const { service } = await seeded();
            mount(service)();
      await flush();
      const heading = (label: string) =>
        Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__list-item .tasks__group")).find(
          (h) => h.querySelector(".tasks__group-label")?.textContent === label,
        )!;
      // To do opens unfolded, Done folded — then the person turns both.
      act(() => heading("To do").click());
      act(() => heading("Done").click());
      await flush();
      expect(settingsStore.current?.tasksBoard.list.folded).toEqual(["backlog", "todo", "cancelled"]);
      act(() => root.unmount());
      root = createRoot(host);
      mount(service)();
      await flush();
      expect(heading("To do").getAttribute("aria-expanded")).toBe("false");
      expect(heading("Done").getAttribute("aria-expanded")).toBe("true");
    } finally {
      restoreList();
    }
  });

  it("duplicates the open task as a fresh one and opens the copy", async () => {
    const { service } = await seeded();
    focus = "task-1";
    mount(service)();
    await flush();
    const before = service.peek("ws-1");
    const count = before?.kind === "ready" ? before.board.tasks.length : 0;
    // The task's menu stands with its id and state, not among the window's controls.
    const menu = document.querySelector('aside[aria-label="Task task-1"] button[aria-label="More for task-1"]')!;
    expect(menu.closest(".tasks__detail-tools")).toBeNull();
    expect(menu.closest(".tasks__detail-line")).not.toBeNull();
    // Through the task's menu (⋯), opened again for the second press.
    const choose = () => {
      act(() => document.querySelector<HTMLButtonElement>('aside[aria-label="Task task-1"] button[aria-label="More for task-1"]')!.click());
      act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Duplicate"))!.click());
    };
    const confirmCopy = () => {
      const dialog = document.querySelector('.confirm[role="dialog"]')!;
      act(() => Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Duplicate")!.click());
    };
    // The menu only asks: nothing is made until the dialog's Duplicate.
    choose();
    expect(document.querySelector('.confirm[role="dialog"] .confirm__title')?.textContent).toBe("Duplicate task-1");
    const asked = service.peek("ws-1");
    expect(asked?.kind === "ready" && asked.board.tasks.length).toBe(count);
    confirmCopy();
    // While that copy is on its way, the menu offers no second one.
    act(() => document.querySelector<HTMLButtonElement>('aside[aria-label="Task task-1"] button[aria-label="More for task-1"]')!.click());
    const again = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Duplicate"));
    expect(again?.disabled || again?.getAttribute("aria-disabled") === "true").toBe(true);
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks.length).toBe(count + 1);
    const copy = state?.kind === "ready" ? state.board.tasks[state.board.tasks.length - 1] : null;
    // Its source's title, and the link says which one is the copy.
    expect(copy?.title).toBe("Draft the skill");
    expect(document.body.textContent).toContain("Copied from");
    expect(copy?.assignee).toBeNull();
    expect(focus).toBe(copy?.id);
  });

  it("transfers the open task to another team from its menu: confirmed in a dialog, then the panel closes", async () => {
    const { service } = await seeded();
    focus = "task-1";
    const render = mount(service);
    render();
    await flush();
    act(() => document.querySelector<HTMLButtonElement>('aside[aria-label="Task task-1"] button[aria-label="More for task-1"]')!.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Transfer"))!.click());
    await flush();
    // A dialog of its own, over everything.
    const confirm = document.querySelector('.confirm[role="dialog"]')!;
    expect(confirm.querySelector(".confirm__title")?.textContent).toBe("Transfer task-1");
    expect(confirm.textContent).toContain("Move it to web?");
    act(() => Array.from(confirm.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Move")!.click());
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks.find((t) => t.id === "task-1")?.teamId).toBe("team-2");
    expect(focus).toBeNull();
  });

  it("renames the open task in place — a double click on its title, or Rename in its menu", async () => {
    const { service } = await seeded();
    focus = "task-1";
    const render = mount(service);
    render();
    await flush();
    const panel = () => document.querySelector('aside[aria-label="Task task-1"]')!;
    const typeAndEnter = (text: string) => {
      // A wrapping field — the title may run to several lines.
      const field = panel().querySelector<HTMLTextAreaElement>("textarea.tasks__detail-title-edit")!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    };
    const titleOf = () => {
      const state = service.peek("ws-1");
      return state?.kind === "ready" ? state.board.tasks.find((t) => t.id === "task-1")?.title : null;
    };
    act(() => void panel().querySelector(".tasks__detail-title")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    typeAndEnter("Draft the skill, again");
    await flush();
    expect(titleOf()).toBe("Draft the skill, again");
    render();
    await flush();
    act(() => panel().querySelector<HTMLButtonElement>('button[aria-label="More for task-1"]')!.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Rename"))!.click());
    typeAndEnter("Draft it");
    await flush();
    expect(titleOf()).toBe("Draft it");
  });

  it("peels one layer per Escape: a confirm over the task, then the field inside it, each its own", async () => {
    const { service } = await seeded();
    focus = "task-1";
    const render = mount(service);
    render();
    await flush();
    const escape = (target: EventTarget = document.body) =>
      act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    act(() => document.querySelector<HTMLButtonElement>('aside[aria-label="Task task-1"] button[aria-label="More for task-1"]')!.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Duplicate"))!.click());
    expect(document.querySelector('.confirm[role="dialog"]')).not.toBeNull();
    escape();
    await flush();
    // The confirm went; the task stayed open.
    expect(document.querySelector('.confirm[role="dialog"]')).toBeNull();
    expect(focus).toBe("task-1");
    // The title's field: its Escape ends the edit, and only that.
    act(() => void document.querySelector('aside[aria-label="Task task-1"] .tasks__detail-title')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    escape(document.querySelector("textarea.tasks__detail-title-edit")!);
    await flush();
    expect(document.querySelector("textarea.tasks__detail-title-edit")).toBeNull();
    expect(focus).toBe("task-1");
  });

  it("creates a task from the form as the user and opens it", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => button("+ Task").click());
    await flush();
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    act(() => {
      // Through the prototype's setter: React's value tracker records a
      // direct `.value` write as already known and fires no change.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Review the copy");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The title's count under it: what is taken of the cap.
    expect(title.parentElement?.querySelector(".tasks__count")?.textContent).toBe("15/120");
    await flush();
    act(() => button("Create task").click());
    await flush();
    render();
    await flush();
    expect(focus).toBe("task-3");
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[2]).toMatchObject({ title: "Review the copy", author: "user", assignee: null });
    expect(text()).toContain("by you");
  });

  it("an epic's card lists its tasks, refuses Done in words while one is open, and makes a new task in it", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-1", title: "The epic", kind: "epic" }, USER_ACTOR);
    await service.apply("ws-1", "task-1", [{ kind: "parent", to: "task-3" }], USER_ACTOR);
    focus = "task-3";
    const render = mount(service);
    render();
    await flush();
    const card = () => document.querySelector<HTMLElement>('aside[aria-label="Task task-3"]')!;
    expect(card().querySelector(".tasks__epic-chip")?.textContent).toBe("EPIC");
    const section = () => card().querySelector<HTMLElement>('section[aria-label="Tasks of the epic"]')!;
    expect([...section().querySelectorAll(".tasks__epic-task .tasks__row-title")].map((t) => t.textContent)).toEqual(["Draft the skill"]);
    expect(section().querySelector(".tasks__epic-summary")?.textContent).toBe("0 of 1 done");
    // The status menu: Done shown, refused, and why.
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Status"]')!.click());
    await flush();
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((o) => o.textContent === "Done")!;
    expect(done.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector(".dropdown__note")?.textContent).toBe("Done and Cancelled wait for the epic's tasks: task-1 (to do)");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Status"]')!.click());
    await flush();
    // A new task made in the epic goes under it.
    const newInEpic = Array.from(section().querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("New task in the epic"))!;
    act(() => newInEpic.click());
    await flush();
    const epicPick = document.querySelector<HTMLButtonElement>('aside[aria-label="New task"] button[aria-label="Epic"] .dropdown__label');
    expect(epicPick?.textContent).toBe("task-3 · The epic");
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Second step");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    act(() => button("Create task").click());
    await flush();
    const state = service.peek("ws-1");
    if (state?.kind !== "ready") throw new Error("not ready");
    const made = state.board.tasks.find((t) => t.title === "Second step")!;
    expect(state.board.relations).toContainEqual(expect.objectContaining({ kind: "child-of", from: made.uid, to: state.board.tasks[2].uid }));
  });

  it("puts a task under an epic from its Epic picker, and out again", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-1", title: "The epic", kind: "epic" }, USER_ACTOR);
    focus = "task-1";
    mount(service)();
    await flush();
    const pick = (label: string) => {
      act(() => document.querySelector<HTMLButtonElement>('aside[aria-label="Task task-1"] button[aria-label="Epic"]')!.click());
      const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((o) => o.textContent === label)!;
      act(() => option.click());
    };
    pick("task-3 · The epic");
    await flush();
    const parentOf = () => {
      const state = service.peek("ws-1");
      return state?.kind === "ready" ? state.board.relations.filter((r) => r.kind === "child-of").length : -1;
    };
    expect(parentOf()).toBe(1);
    pick("No epic");
    await flush();
    expect(parentOf()).toBe(0);
  });

  it("the form can be put away three ways — Cancel, + Task again, Escape — and Escape does not take the dialog with it", async () => {
    const { service } = await seeded();
    const onClose = vi.fn();
    const render = () =>
      act(() =>
        root.render(
          createElement(TasksDialog, {
            tasks: access(service),
            artifactReads,
            workspace: teamedWorkspaces()[0],
            stageTeam,
            focus,
            onFocus,
            onClose,
          }),
        ),
      );
    render();
    await flush();
    const formOpen = () => document.querySelector('aside[aria-label="New task"]') !== null;

    act(() => button("+ Task").click());
    await flush();
    expect(formOpen()).toBe(true);
    act(() => button("+ Task").click());
    await flush();
    expect(formOpen()).toBe(false);

    act(() => button("+ Task").click());
    await flush();
    act(() => button("Cancel").click());
    await flush();
    expect(formOpen()).toBe(false);

    act(() => button("+ Task").click());
    await flush();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(formOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an open task is put away by Close, by pressing its card again, or by Escape — which does not take the dialog", async () => {
    const { service } = await seeded();
    const onClose = vi.fn();
    const render = () =>
      act(() =>
        root.render(
          createElement(TasksDialog, {
            tasks: access(service),
            artifactReads,
            workspace: teamedWorkspaces()[0],
            stageTeam,
            focus,
            onFocus: (id: string | null) => {
              onFocus(id);
              render();
            },
            onClose,
          }),
        ),
      );
    render();
    await flush();
    const panel = () => document.querySelector('aside[aria-label="Task task-1"]');

    act(() => rowOpens()[0].click());
    await flush();
    expect(panel()).not.toBeNull();
    act(() => button("Close").click());
    await flush();
    expect(panel()).toBeNull();

    act(() => rowOpens()[0].click());
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    expect(panel()).toBeNull();

    act(() => rowOpens()[0].click());
    await flush();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(panel()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  /** A board with `n` tasks in To do, titled "Task 0"… in queue order. */
  async function crowded(n: number) {
    const workspaces = teamedWorkspaces();
    const service = createTasksService({ workspaces: () => workspaces, store: fakeStore().port, now: () => 1_000 });
    for (let i = 0; i < n; i += 1) {
      await service.create("ws-1", { teamId: "team-1", title: `Task ${i}` }, USER_ACTOR);
    }
    return service;
  }
  /** A status group's heading in the list, by its words. */
  const groupHeading = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(".tasks__list-item .tasks__group")).find(
      (h) => h.querySelector(".tasks__group-label")?.textContent === label,
    )!;
  const pointerAt = (type: string, target: EventTarget, x: number, y: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

  it("the list mounts the rows in view, not its whole pile — and its heading still counts them all", async () => {
    const render = mount(await crowded(200));
    render();
    await flush();
    expect(groupHeading("To do").querySelector(".tasks__group-count")?.textContent).toBe("200");
    const mounted = document.querySelectorAll(".tasks__list .tasks__row").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40);
  });

  it("a drag survives its row scrolling out of the window: the ghost stays, the drop lands", async () => {
    const service = await crowded(60);
    const render = mount(service);
    render();
    await flush();
    const first = rowOpens().find((c) => c.querySelector(".tasks__row-title")?.textContent === "Task 0")!;
    act(() => void pointerAt("pointerdown", first, 10, 10));
    await flush();
    act(() => void pointerAt("pointermove", window, 40, 40));
    await flush();

    // Scroll the list far down: the row being dragged leaves the window.
    const list = document.querySelector<HTMLElement>(".tasks__list")!;
    act(() => {
      list.scrollTop = 60 * 34;
      list.dispatchEvent(new Event("scroll"));
    });
    await flush();
    // The list's rows only — the ghost is a row too.
    expect(rowTitles().length).toBeGreaterThan(0);
    expect(rowTitles()).not.toContain("Task 0");
    expect(document.querySelector(".tasks__ghost .tasks__row-title")?.textContent).toBe("Task 0");

    const done = groupHeading("Done");
    act(() => void pointerAt("pointerover", done, 40, 300));
    act(() => void pointerAt("pointerup", done, 40, 300));
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks.find((t) => t.title === "Task 0")?.status).toBe("done");
  });

  it("draws a long thread a window at a time, the comment field under it whole", async () => {
    // A card shorter than its thread: 300 comments, a few in view.
    const restoreShort = pinListViewport("tasks__detail-body", 400, 440, 40);
    onTestFinished(restoreShort);
    const comments = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, at: 1_000 + i, from: "lead", body: `note ${i + 1}` }));
    const store = fakeStore({ "ws-1": encodeBoard(boardOf([taskOf({ id: "task-1", teamId: "team-1", comments })], 2)) });
    const workspaces = teamedWorkspaces();
    const service = createTasksService({ workspaces: () => workspaces, store: store.port, now: () => 1_000 });
    focus = "task-1";
    mount(service)();
    await flush();
    const drawn = document.querySelectorAll(".tasks__detail-body .tasks__comment").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(60);
    // A reader reaches the comments by their heading.
    expect(document.querySelector(".tasks__detail-body h4")?.textContent).toBe("Comments");
    // The field is not a row: it stands under the list, whatever is in view.
    const field = document.querySelector(".tasks__detail-composer textarea");
    expect(field).not.toBeNull();
    expect(field!.closest(".tasks__detail-body")).toBeNull();
  });

  it("the history rests compact and opens whole from its heading, its chevron turning", async () => {
    const { service } = await seeded();
    focus = "task-1";
    mount(service)();
    await flush();
    const heading = () => document.querySelector<HTMLButtonElement>(".tasks__section--toggle")!;
    expect(heading().getAttribute("aria-expanded")).toBe("false");
    // The toggle is a heading's: a reader reaches the activity by it.
    expect(heading().parentElement?.tagName).toBe("H4");
    expect(heading().querySelector(".kd-chevron")?.className).toBe("kd-chevron");
    act(() => heading().click());
    await flush();
    expect(heading().getAttribute("aria-expanded")).toBe("true");
    expect(heading().querySelector(".kd-chevron")?.className).toBe("kd-chevron kd-chevron--open");
  });

  it("the open task floats over the whole dialog, its toolbar included — not under it in the stage", async () => {
    const { service } = await seeded();
    focus = "task-1";
    mount(service)();
    await flush();
    const card = document.querySelector(".tasks__detail")!;
    expect(card.parentElement?.getAttribute("role")).toBe("dialog");
    expect(card.closest(".tasks__stage")).toBeNull();
    // The head under it is out of reach while it is up.
    expect(document.querySelector(".tasks__head")!.hasAttribute("inert")).toBe(true);
    // Expand is named for what it is; its state is said, not its next press.
    const expand = card.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!;
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    act(() => expand.click());
    await flush();
    expect(card.querySelector('button[aria-label="Expand"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  it("a list row is dragged onto another group — its heading, even folded — and the task moves there", async () => {
    const { service } = await seeded();
    mount(service)();
    await flush();
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    const heading = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(".tasks__list-item .tasks__group")).find((h) =>
        h.querySelector(".tasks__group-label")?.textContent === label,
      )!;
    const row = () => document.querySelector<HTMLElement>(".tasks__row-open")!;

    act(() => void pointer("pointerdown", row(), 10, 10));
    await flush();
    act(() => void pointer("pointermove", window, 40, 40));
    await flush();
    // The ghost is the list's own row: the same line, the same parts.
    expect(document.querySelector(".tasks__ghost .tasks__row .tasks__row-title")?.textContent).toBe("Draft the skill");
    expect(document.querySelector(".tasks__ghost .tasks__row .tasks__row-who")?.textContent).toBe("impl-1");
    expect(document.querySelector(".tasks__list .tasks__row")!.className).toContain("tasks__row--dragging");
    act(() => void pointer("pointerover", heading("Done"), 40, 300));
    await flush();
    expect(heading("Done").className).toContain("tasks__drop--over");
    // Every group's fold as it stood before the drop.
    const folds = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".tasks__list-item .tasks__group"), (h) => [
        h.querySelector(".tasks__group-label")?.textContent,
        h.getAttribute("aria-expanded"),
      ]);
    const before = folds();
    // Done is folded — its heading still takes the drop.
    act(() => void pointer("pointerup", heading("Done"), 40, 300));
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].status).toBe("done");
    expect(document.querySelector(".tasks__ghost")).toBeNull();
    // The group it went into stays folded — a fold is the person's own
    // act — and counts the task in its heading.
    expect(heading("Done").getAttribute("aria-expanded")).toBe("false");
    // …and no other group's fold moves either: a drop writes no fold.
    expect(folds()).toEqual(before);
    expect(heading("Done").querySelector(".tasks__group-count")?.textContent).toBe("1");
    const titles = Array.from(document.querySelectorAll(".tasks__list .tasks__row .tasks__row-title"), (t) => t.textContent);
    expect(titles).not.toContain("Draft the skill");
  });

  it("an epic stands with its tasks under it: its chevron folds them, and one dragged to a group changes status, staying under it", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-1", title: "The epic", kind: "epic" }, USER_ACTOR);
    await service.apply("ws-1", "task-2", [{ kind: "parent", to: "task-3" }], USER_ACTOR);
    mount(service)();
    await flush();
    // To do holds the epic (its own status) and the task under it; the task is in no other group.
    expect(rowTitles()).toEqual(["Draft the skill", "The epic", "Pooled work"]);
    expect(groupHeading("To do").querySelector(".tasks__group-count")?.textContent).toBe("3");
    const fold = () => document.querySelector<HTMLButtonElement>(".tasks__list .tasks__row-fold")!;
    act(() => fold().click());
    await flush();
    expect(rowTitles()).toEqual(["Draft the skill", "The epic"]);
    // The fold is a setting, kept by the epic's uid: closed and opened again, the epic stays folded.
    const epic = service.peek("ws-1");
    const epicUid = epic?.kind === "ready" ? epic.board.tasks.find((t) => t.id === "task-3")?.uid : undefined;
    expect(settingsStore.current?.tasksBoard.list.foldedEpics).toEqual([epicUid]);
    act(() => root.unmount());
    root = createRoot(host);
    mount(service)();
    await flush();
    expect(rowTitles()).toEqual(["Draft the skill", "The epic"]);
    act(() => fold().click());
    await flush();
    expect(settingsStore.current?.tasksBoard.list.foldedEpics).toEqual([]);
    act(() => fold().click());
    act(() => fold().click());
    await flush();
    const pooled = () => rowOpens().find((c) => c.querySelector(".tasks__row-title")?.textContent === "Pooled work")!;
    act(() => void pointerAt("pointerdown", pooled(), 10, 10));
    await flush();
    act(() => void pointerAt("pointermove", window, 40, 40));
    await flush();
    act(() => void pointerAt("pointerover", groupHeading("In progress"), 40, 300));
    act(() => void pointerAt("pointerup", groupHeading("In progress"), 40, 300));
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[1].status).toBe("in-progress");
    // Still under its epic, in the epic's group — its ring says where it stands.
    expect(rowTitles()).toEqual(["Draft the skill", "The epic", "Pooled work"]);
    expect(pooled().closest(".tasks__row")?.className).toContain("tasks__row--under-epic");
  });

  it("a release after a drag opens nothing; a press that does not travel is a click that opens the row", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => void pointerAt("pointerdown", rowOpens()[0], 10, 10));
    await flush();
    act(() => void pointerAt("pointermove", window, 40, 40));
    await flush();
    act(() => void pointerAt("pointerover", groupHeading("In progress"), 40, 300));
    await flush();
    // Release over In progress: the move lands, the flight ends, the click
    // that follows the release opens nothing.
    act(() => void pointerAt("pointerup", groupHeading("In progress"), 40, 300));
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].status).toBe("in-progress");
    expect(document.querySelector(".tasks__ghost")).toBeNull();
    expect(focus).toBeNull();

    // A press that does not travel is a click: the row opens.
    await new Promise((resolve) => setTimeout(resolve, 260));
    const pooled = () => rowOpens().find((c) => c.querySelector(".tasks__row-title")?.textContent === "Pooled work")!;
    act(() => {
      pointerAt("pointerdown", pooled(), 10, 10);
      pointerAt("pointerup", pooled(), 10, 10);
    });
    await flush();
    act(() => pooled().click());
    await flush();
    expect(focus).toBe("task-2");
  });

  it("Escape puts a drag back — nothing moves, nothing closes, and the release's click opens nothing", async () => {
    const { service } = await seeded();
    mount(service)();
    await flush();
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    act(() => void pointer("pointerdown", rowOpens()[0], 10, 10));
    await flush();
    act(() => void pointer("pointermove", window, 40, 40));
    await flush();
    expect(document.querySelector(".tasks__ghost")).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(document.querySelector(".tasks__ghost")).toBeNull();
    act(() => {
      pointer("pointerup", rowOpens()[0], 40, 40);
      rowOpens()[0].click();
    });
    await flush();
    expect(focus).toBeNull();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].status).toBe("todo");
  });

  it("under StrictMode one release is one move: the drop's IO runs outside any React updater", async () => {
    const { service } = await seeded();
    const applies = vi.spyOn(service, "apply");
    const render = mount(service, teamedWorkspaces()[0], true);
    render();
    await flush();
    const column = groupHeading("Done");
    const pointer = pointerAt;
    act(() => {
      pointer("pointerdown", rowOpens()[0], 10, 10);
    });
    await flush();
    act(() => {
      pointer("pointermove", window, 40, 40);
    });
    await flush();
    act(() => {
      pointer("pointerup", column, 300, 40);
    });
    await flush();
    expect(applies).toHaveBeenCalledTimes(1);
    expect(applies).toHaveBeenCalledWith("ws-1", "task-1", [{ kind: "status", to: "done" }], expect.anything());
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].log.filter((line) => line.field === "status")).toHaveLength(1);
  });

  it("attaches an artifact from the registry, opens it on click, and detaches it", async () => {
    const restorePalette = pinListViewport("palette__list", 400, 640, 34);
    onTestFinished(restorePalette);
    registry.rows = [{ id: "kd-tasks", title: "KeepDeck Tasks" }];
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    await flush();
    const picker = document.querySelector<HTMLButtonElement>('button[aria-label="Attach an artifact"]')!;
    act(() => picker.click());
    await flush();
    act(() => paletteOption("KeepDeck Tasks").click());
    await flush();
    render();
    await flush();
    let state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].artifacts).toEqual(["kd-tasks"]);
    // Attached: the picker has nothing left to offer; the row opens it.
    expect(document.querySelector('button[aria-label="Attach an artifact"]')).toBeNull();
    // The chip opens it; its slug is in its title, the durable half.
    const row = buttons().find((b) => b.textContent === "KeepDeck Tasks")!;
    expect(row.title).toContain("kd-tasks");
    act(() => row.click());
    expect(openArtifactByRef).toHaveBeenCalledWith("ws-1", "kd-tasks");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Detach kd-tasks"]')!.click());
    await flush();
    state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].artifacts).toEqual([]);
    registry.rows = [];
  });

  it("makes the open task wait on another from the Blocked by row, and lets it go again", async () => {
    const restorePalette = pinListViewport("palette__list", 400, 640, 34);
    onTestFinished(restorePalette);
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    await flush();
    const picker = document.querySelector<HTMLButtonElement>('button[aria-label="Add a blocker"]')!;
    act(() => picker.click());
    await flush();
    // A palette over the panel, naming what is picked.
    expect(document.querySelector<HTMLInputElement>(".palette__field")?.placeholder).toBe("Find a task task-1 waits on…");
    act(() => paletteOption("task-2  Pooled work").click());
    await flush();
    render();
    await flush();
    const blockers = () => {
      const state = service.peek("ws-1");
      if (state?.kind !== "ready") return null;
      return blockerIdsOf(state.board.tasks[0], state.board);
    };
    expect(blockers()).toEqual(["task-2"]);
    // Waiting on the only other task: nothing left to offer.
    expect(document.querySelector('button[aria-label="Add a blocker"]')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Stop waiting on task-2"]')!.click());
    await flush();
    expect(blockers()).toEqual([]);
  });

  it("links from the task's menu the other way round — a task that waits on this one — and Escape shuts only the palette", async () => {
    const restorePalette = pinListViewport("palette__list", 400, 640, 34);
    onTestFinished(restorePalette);
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    await flush();
    const menu = () => document.querySelector<HTMLButtonElement>('button[aria-label="More for task-1"]')!;
    const item = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes(label))!;
    // Escape closes the palette, not the open task under it.
    act(() => menu().click());
    act(() => item("Blocks…").click());
    await flush();
    act(() => document.querySelector<HTMLInputElement>(".palette__field")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(document.querySelector(".palette")).toBeNull();
    expect(document.querySelector('aside[aria-label="Task task-1"]')).not.toBeNull();
    act(() => menu().click());
    act(() => item("Blocks…").click());
    await flush();
    expect(document.querySelector<HTMLInputElement>(".palette__field")?.placeholder).toBe("Find a task that waits on task-1…");
    act(() => paletteOption("task-2  Pooled work").click());
    await flush();
    const state = service.peek("ws-1");
    // The link is made on the waiting task: task-2 now waits on task-1.
    expect(state?.kind === "ready" && blockerIdsOf(state.board.tasks[1], state.board)).toEqual(["task-1"]);
  });

  it("opens on a task of another team when a link names it — the board switches to that team", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    focus = "task-3";
    const render = mount(service);
    render();
    await flush();
    expect(document.querySelector('aside[aria-label="Task task-3"]')).not.toBeNull();
    expect(text()).toContain("Web's own");
    expect(rowTitles()).toEqual(["Web's own"]);
  });

  it("opens on the team the stage has open, and falls back to the first at the cards level", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    stageTeam = "team-2";
    mount(service)();
    await flush();
    expect(rowTitles()).toEqual(["Web's own"]);
    act(() => root.unmount());
    root = createRoot(host);
    stageTeam = null;
    mount(service)();
    await flush();
    expect(rowTitles()).toEqual(["Draft the skill", "Pooled work"]);
  });

  it("the stage moving under the open dialog does not move the board", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    stageTeam = "team-2";
    const render = mount(service);
    render();
    await flush();
    stageTeam = "team-1";
    render();
    await flush();
    expect(rowTitles()).toEqual(["Web's own"]);
  });

  it("another workspace under the open dialog opens its board from ITS stage, not the old choice", async () => {
    const { service, workspaces } = await seeded();
    // The same teams under another id: without the remount the old choice
    // (web) would still name a team there and keep the board on it.
    const twin = { ...workspaces[0], id: "ws-3" };
    workspaces.push(twin);
    stageTeam = "team-2";
    const render = mount(service, workspaces[0]);
    render();
    await flush();
    expect(teamPicked()).toBe("web");
    stageTeam = "team-1";
    render(twin);
    await flush();
    expect(teamPicked()).toBe("api");
  });

  it("a board a link opened on another team stays there when the task is put away", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    focus = "task-3";
    const render = mount(service);
    render();
    await flush();
    act(() => button("Close").click());
    await flush();
    expect(focus).toBeNull();
    expect(rowTitles()).toEqual(["Web's own"]);
  });

  it("a second link while the dialog is up moves the board to ITS task's team, pinned choice or not", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    focus = "task-3";
    const render = mount(service);
    render();
    await flush();
    // Putting the task away pins web as the choice…
    act(() => button("Close").click());
    await flush();
    expect(teamPicked()).toBe("web");
    // …and a link to api's task still outranks it: the modal router only
    // refocuses an open dialog, it does not remount it.
    focus = "task-1";
    render();
    await flush();
    expect(teamPicked()).toBe("api");
    expect(document.querySelector('aside[aria-label="Task task-1"]')).not.toBeNull();
  });

  it("+ Task on a board a link opened creates into THAT team, not the first", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    focus = "task-3";
    const render = mount(service);
    render();
    await flush();
    act(() => button("+ Task").click());
    await flush();
    const title = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Also web's");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    act(() => button("Create task").click());
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[3]).toMatchObject({ title: "Also web's", teamId: "team-2" });
  });

  it("keeps a refused comment in the composer, and a draft does not follow the person to another task", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
    const type = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), value);
        composer().dispatchEvent(new Event("input", { bubbles: true }));
      });
    // Over the cap: the domain's own predicate keeps Comment off, and the
    // draft stays.
    type("x".repeat(4001));
    expect(button("Comment").disabled).toBe(true);
    expect(composer().value).toHaveLength(4001);

    // A refusal the composer could not foresee comes back from the owner:
    // the draft stays, the refusal shows.
    const realApply = service.apply.bind(service);
    service.apply = async () => {
      service.apply = realApply;
      return { ok: false, refusal: { kind: "not-on-team" } };
    };
    type("a note the owner refuses");
    act(() => button("Comment").click());
    await flush();
    await flush();
    expect(text()).toContain("another team's board");
    expect(composer().value).toBe("a note the owner refuses");

    type("a note for task-1");
    act(() => rowOpens()[1].click());
    await flush();
    expect(composer().value).toBe("");
    type("for task-2");
    act(() => button("Comment").click());
    await flush();
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[1].comments.map((c) => c.body)).toEqual(["for task-2"]);
    expect(state?.kind === "ready" && state.board.tasks[0].comments).toEqual([]);
    expect(composer().value).toBe("");
  });

  it("text typed while a comment is being sent is not lost when the send lands", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => rowOpens()[0].click());
    await flush();
    const composer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
    const type = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), value);
        composer().dispatchEvent(new Event("input", { bubbles: true }));
      });
    // The owner's answer is held: the send is out, the person keeps typing.
    const realApply = service.apply.bind(service);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.apply = async (...args) => {
      service.apply = realApply;
      await held;
      return realApply(...args);
    };
    type("first");
    act(() => button("Comment").click());
    await flush();
    expect(button("Comment").disabled).toBe(true);
    type("second, typed meanwhile");
    release();
    await flush();
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].comments.map((c) => c.body)).toEqual(["first"]);
    expect(composer().value).toBe("second, typed meanwhile");
    expect(button("Comment").disabled).toBe(false);
  });

  it("a row's title and the panel's title stand whole; a blocker is a chip saying where it stands", async () => {
    const { service } = await seeded();
    await service.apply("ws-1", "task-1", [{ kind: "blockedBy", to: ["task-2"] }], USER_ACTOR);
    focus = "task-1";
    mount(service)();
    await flush();
    // A row grows a line for each line its title wraps to: never clamped.
    const titles = Array.from(document.querySelectorAll(".tasks__list .tasks__row-title"));
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.some((t) => t.classList.contains("kd-one-line") || t.classList.contains("kd-two-lines"))).toBe(false);
    // The panel is where the whole title is read: never clamped.
    expect(document.querySelector('aside[aria-label="Task task-1"] .tasks__detail-title')?.classList.contains("kd-two-lines")).toBe(false);
    // Its words open the blocker; the cross beside them lets it go.
    const blocker = document.querySelector('aside[aria-label="Task task-1"] .tasks__tag--blocking .tasks__link');
    expect(blocker?.textContent).toBe("task-2 · to do");
  });

  it("names the one team as a word, kept to one line", async () => {
    const { service } = await seeded();
    const [ws] = teamedWorkspaces();
    mount(service, { ...ws, teams: [ws.teams![0]] })();
    await flush();
    expect(document.querySelector(".tasks__team-name")?.classList.contains("kd-one-line")).toBe(true);
  });

  it("walks the ladder: no workspace, owner down, empty board", async () => {
    const render = mount(null, null as never);
    render();
    await flush();
    expect(text()).toContain("No workspace open");
    act(() => root.unmount());
    root = createRoot(host);
    const service = createTasksService({ workspaces: () => teamedWorkspaces(), store: fakeStore().port });
    const again = mount(service);
    again();
    await flush();
    expect(text()).toContain("Nothing on the board yet");
    expect(text()).toContain("agents read the board themselves");
  });
});
