// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTasksService, type TasksService } from "../../app/tasks";
import { fakeStore, teamedWorkspaces } from "../../app/tasks/testSupport";
import { USER_ACTOR, agentActor } from "../../domain/tasks";
import { TasksDialog } from "./TasksDialog";
import type { TasksAccess } from "./useTasksBoard";

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
  it("shows the board as columns, opens a task on click, and moves it with the ladder's own verbs", async () => {
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

    // The status picker offers only what the table allows from todo.
    const statusPicker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Status"]')!;
    const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    act(() => statusPicker().click());
    await flush();
    expect(options().map((o) => o.textContent)).toEqual(["To do", "Doing", "Cancelled"]);
    act(() => options().find((o) => o.textContent === "Doing")!.click());
    await flush();
    render();
    await flush();
    const state = service.peek("ws-1");
    expect(state?.kind === "ready" && state.board.tasks[0].status).toBe("doing");
    act(() => statusPicker().click());
    await flush();
    expect(options().map((o) => o.textContent)).toEqual(["Doing", "Blocked", "Review", "Cancelled"]);
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
