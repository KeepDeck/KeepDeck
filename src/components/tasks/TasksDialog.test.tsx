// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTasksService, type TasksService } from "../../app/tasks";
import { fakeStore, teamedWorkspaces } from "../../app/tasks/testSupport";
import { USER_ACTOR, agentActor } from "../../domain/tasks";
import { TasksDialog } from "./TasksDialog";
import type { TasksAccess } from "./useTasksBoard";
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
const onFocus = (id: string | null) => {
  focus = id;
};

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  focus = null;
});
afterEach(() => act(() => root.unmount()));

const text = () => document.body.textContent ?? "";
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
const button = (label: string) => {
  const found = buttons().find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" among ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
};
const cards = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__card"));

function mount(service: TasksService | null, workspace = teamedWorkspaces()[0]) {
  const render = () =>
    act(() =>
      root.render(
        createElement(TasksDialog, {
          tasks: access(service),
          artifactReads,
          workspace,
          focus,
          onFocus: (id: string | null) => {
            onFocus(id);
            render();
          },
          onClose: vi.fn(),
        }),
      ),
    );
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
    act(() => buttons().find((b) => b.textContent?.startsWith("KeepDeck Tasks"))!.click());
    expect(openArtifactByRef).toHaveBeenCalledWith("ws-1", "kd-tasks");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Detach kd-tasks"]')!.click());
    await flush();
    state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].artifacts).toEqual([]);
    registry.rows = [];
  });

  it("the queues view lays out a lane per member and the pool", async () => {
    const { service } = await seeded();
    const render = mount(service);
    render();
    await flush();
    act(() => button("Queues").click());
    await flush();
    const lanes = Array.from(document.querySelectorAll(".tasks__lane-name")).map((el) => el.textContent);
    expect(lanes).toEqual(["lead", "impl-1", "impl-2", "pool"]);
    expect(text()).toContain("1 queued · unassigned");
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
