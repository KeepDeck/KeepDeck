// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTasksService, type TasksService } from "../../app/tasks";
import { fakeStore, teamedWorkspaces } from "../../app/tasks/testSupport";
import { USER_ACTOR, agentActor } from "../../domain/tasks";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { TasksDialog } from "./TasksDialog";
import type { TasksAccess } from "./useTasksBoard";
import type { Workspace } from "../../domain/deck";
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

/** The columns are windowed lists: happy-dom lays nothing out, so the
 * browser's geometry is imitated — each column 600px tall, a card 64. */
let restoreViewport: () => void;

beforeEach(() => {
  installResizeObserver();
  restoreViewport = pinListViewport("tasks__column-body", 600);
  document.body.innerHTML = "";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  focus = null;
  stageTeam = null;
});
afterEach(() => {
  act(() => root.unmount());
  restoreViewport();
});

const text = () => document.body.textContent ?? "";
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const button = (label: string) => {
  const found = buttons().find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" among ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
};
const teamPicked = () => document.querySelector('button[aria-label="Team"] .dropdown__label')?.textContent;
const cards = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__card"));

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

async function seeded() {
  const workspaces = teamedWorkspaces();
  const service = createTasksService({ workspaces: () => workspaces, store: fakeStore().port, now: () => 1_000 });
  await service.create("ws-1", { teamId: "team-1", title: "Draft the skill", assignee: "impl-1" }, agentActor("lead", "team-1"));
  await service.create("ws-1", { teamId: "team-1", title: "Pooled work" }, USER_ACTOR);
  return { service, workspaces };
}

describe("TasksDialog", () => {
  it("shows the board as columns, opens a task on click, and moves it with the status picker", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    expect(text()).toContain("To do");
    expect(cards().map((c) => c.querySelector(".tasks__card-title")?.textContent)).toEqual(["Draft the skill", "Pooled work"]);

    act(() => cards()[0].click());
    await flush();
    expect(focus).toBe("task-1");
    expect(text()).toContain("task-1 · by lead");

    // The status picker offers the person every status, in board order.
    const statusPicker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Status"]')!;
    const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const EVERY = ["Blocked", "To do", "In progress", "Review", "Done", "Cancelled"];
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
    await flush();
    act(() => button("Create task").click());
    await flush();
    render();
    await flush();
    expect(focus).toBe("task-3");
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[2]).toMatchObject({ title: "Review the copy", author: "user", assignee: null });
    expect(text()).toContain("task-3 · by you");
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

    act(() => cards()[0].click());
    await flush();
    expect(panel()).not.toBeNull();
    act(() => button("Close").click());
    await flush();
    expect(panel()).toBeNull();

    act(() => cards()[0].click());
    await flush();
    act(() => cards()[0].click());
    await flush();
    expect(panel()).toBeNull();

    act(() => cards()[0].click());
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
  const columnBody = (label: string) =>
    document.querySelector<HTMLElement>(`section[aria-label="${label}"] .tasks__column-body`)!;

  it("a column mounts the cards in view, not its whole pile — and still counts them all", async () => {
    const render = mount(await crowded(200));
    render();
    await flush();
    const todo = document.querySelector<HTMLElement>('section[aria-label="To do"]')!;
    expect(todo.querySelector(".tasks__column-count")?.textContent).toBe("200");
    const mounted = todo.querySelectorAll(".tasks__card").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40);
  });

  it("a drag survives its card scrolling out of the window: the ghost stays, the drop lands", async () => {
    const service = await crowded(60);
    const render = mount(service);
    render();
    await flush();
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    const first = cards().find((c) => c.querySelector(".tasks__card-title")?.textContent === "Task 0")!;
    act(() => pointer("pointerdown", first, 10, 10));
    await flush();
    act(() => pointer("pointermove", window, 40, 40));
    await flush();

    // Scroll To do far down: the card being dragged leaves the window.
    const body = columnBody("To do");
    act(() => {
      body.scrollTop = 60 * 64 - 600;
      body.dispatchEvent(new Event("scroll"));
    });
    await flush();
    // The column's cards only — the ghost is a card too.
    const titles = Array.from(body.querySelectorAll(".tasks__card-title")).map((t) => t.textContent);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles).not.toContain("Task 0");
    expect(document.querySelector(".tasks__ghost .tasks__card-title")?.textContent).toBe("Task 0");

    const done = document.querySelector<HTMLElement>('section[aria-label="Done"]')!;
    act(() => pointer("pointerover", done, 300, 40));
    act(() => pointer("pointerup", done, 300, 40));
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks.find((t) => t.title === "Task 0")?.status).toBe("done");
  });

  it("a card is dragged with the pointer and dropped on a column; a plain press still opens one", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    const column = (label: string) => document.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

    // Press, travel past the threshold: a drag, with a ghost and targets.
    act(() => {
      pointer("pointerdown", cards()[0], 10, 10);
    });
    await flush();
    act(() => {
      pointer("pointermove", window, 40, 40);
    });
    await flush();
    // The ghost is the card: same title line, same meta line.
    expect(document.querySelector(".tasks__ghost .tasks__card-title")?.textContent).toBe("Draft the skill");
    expect(document.querySelector(".tasks__ghost .tasks__card-meta")?.textContent).toContain("task-1 · impl-1");
    expect(column("Done").className).toContain("tasks__column--drop-ok");
    act(() => {
      pointer("pointerover", column("Done"), 300, 40);
    });
    await flush();
    expect(column("Done").className).toContain("tasks__column--drop-over");

    // Release over Done: the move lands, the flight ends, the click that
    // follows the release opens nothing.
    act(() => {
      pointer("pointerup", column("Done"), 300, 40);
    });
    await flush();
    act(() => cards()[0].click());
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].status).toBe("done");
    expect(document.querySelector(".tasks__ghost")).toBeNull();
    expect(focus).toBeNull();

    // A press that does not travel is a click: the card opens.
    act(() => {
      pointer("pointerdown", cards()[0], 10, 10);
      pointer("pointerup", cards()[0], 10, 10);
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 260));
    act(() => cards()[0].click());
    await flush();
    expect(focus).toBe("task-2");
  });

  it("under StrictMode one release is one move: the drop's IO runs outside any React updater", async () => {
    const { service } = await seeded();
    const applies = vi.spyOn(service, "apply");
    const render = mount(service, teamedWorkspaces()[0], true);
    render();
    await flush();
    const column = document.querySelector<HTMLElement>('section[aria-label="Done"]')!;
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    act(() => {
      pointer("pointerdown", cards()[0], 10, 10);
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
    registry.rows = [{ id: "kd-tasks", title: "KeepDeck Tasks" }];
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => cards()[0].click());
    await flush();
    await flush();
    const picker = document.querySelector<HTMLButtonElement>('button[aria-label="Attach artifact"]')!;
    act(() => picker.click());
    await flush();
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((o) => o.textContent === "KeepDeck Tasks")!.click());
    await flush();
    render();
    await flush();
    let state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].artifacts).toEqual(["kd-tasks"]);
    // Attached: the picker has nothing left to offer; the row opens it.
    expect(text()).toContain("Every artifact of this workspace is attached");
    // The row wraps to two lines, then ellipsizes — never one cut line.
    const row = buttons().find((b) => b.textContent?.startsWith("KeepDeck Tasks"))!;
    expect(row.querySelector(".kd-two-lines")?.textContent).toContain("kd-tasks");
    act(() => row.click());
    expect(openArtifactByRef).toHaveBeenCalledWith("ws-1", "kd-tasks");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Detach kd-tasks"]')!.click());
    await flush();
    state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].artifacts).toEqual([]);
    registry.rows = [];
  });

  it("closed columns show their cards and offer no Hide or Show", async () => {
    const { service } = await seeded();
    await service.apply("ws-1", "task-1", [{ kind: "status", to: "done" }], USER_ACTOR);
    const render = mount(service);
    render();
    await flush();
    const done = document.querySelector<HTMLElement>('section[aria-label="Done"]')!;
    expect(done.querySelectorAll(".tasks__card")).toHaveLength(1);
    expect(buttons().some((b) => ["Hide", "Show"].includes(b.textContent?.trim() ?? ""))).toBe(false);
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
    expect(cards().map((c) => c.querySelector(".tasks__card-title")?.textContent)).toEqual(["Web's own"]);
  });

  it("opens on the team the stage has open, and falls back to the first at the cards level", async () => {
    const { service } = await seeded();
    await service.create("ws-1", { teamId: "team-2", title: "Web's own" }, agentActor("lead", "team-2"));
    stageTeam = "team-2";
    mount(service)();
    await flush();
    expect(cards().map((c) => c.querySelector(".tasks__card-title")?.textContent)).toEqual(["Web's own"]);
    act(() => root.unmount());
    root = createRoot(host);
    stageTeam = null;
    mount(service)();
    await flush();
    expect(cards().map((c) => c.querySelector(".tasks__card-title")?.textContent)).toEqual(["Draft the skill", "Pooled work"]);
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
    expect(cards().map((c) => c.querySelector(".tasks__card-title")?.textContent)).toEqual(["Web's own"]);
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
    expect(cards().map((c) => c.querySelector(".tasks__card-title")?.textContent)).toEqual(["Web's own"]);
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
    act(() => cards()[0].click());
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
    act(() => cards()[1].click());
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
    act(() => cards()[0].click());
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

  it("always shows the Cancelled column with its cards — there is no filter to turn it on", async () => {
    const { service } = await seeded();
    await service.apply("ws-1", "task-2", [{ kind: "status", to: "cancelled" }], USER_ACTOR);
    mount(service)();
    await flush();
    const cancelled = document.querySelector<HTMLElement>('section[aria-label="Cancelled"]');
    expect(cancelled?.querySelectorAll(".tasks__card")).toHaveLength(1);
    expect(buttons().some((b) => /cancelled/i.test(b.textContent ?? ""))).toBe(false);
  });

  it("keeps a card's title to one line; the panel's title and blocker rows clamp to two", async () => {
    const { service } = await seeded();
    await service.apply("ws-1", "task-1", [{ kind: "blockedBy", to: ["task-2"] }], USER_ACTOR);
    focus = "task-1";
    mount(service)();
    await flush();
    expect(cards().every((c) => c.querySelector(".tasks__card-title")?.classList.contains("kd-one-line"))).toBe(true);
    // The panel's title clamps to two lines.
    expect(document.querySelector('aside[aria-label="Task task-1"] .tasks__detail-title')?.classList.contains("kd-two-lines")).toBe(true);
    const blockers = document.querySelector('aside[aria-label="Task task-1"] .tasks__links');
    expect(blockers?.querySelector(".kd-two-lines")?.textContent).toContain("task-2");
  });

  it("names the one team as a word, kept to one line", async () => {
    const { service } = await seeded();
    const [ws] = teamedWorkspaces();
    mount(service, { ...ws, teams: [ws.teams![0]] })();
    await flush();
    expect(document.querySelector(".tasks__team-name")?.classList.contains("kd-one-line")).toBe(true);
  });

  it("is one board: no Board/Queues switch, no lanes — the columns are the only view", async () => {
    const { service } = await seeded();
    mount(service)();
    await flush();
    expect(document.querySelector('[role="group"][aria-label="View"]')).toBeNull();
    expect(buttons().some((b) => b.textContent?.trim() === "Queues")).toBe(false);
    expect(document.querySelector(".tasks__columns")).not.toBeNull();
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
