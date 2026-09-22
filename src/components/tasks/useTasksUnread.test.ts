// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotificationCenter, type NotificationCenter } from "../../app/notificationCenter";
import { useBoardSeen } from "../../app/tasks/useBoardSeen";
import type { NotificationWorkspace } from "../../domain/notifications";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { useTasksUnread } from "./useTasksUnread";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ws: NotificationWorkspace = { id: "ws-1", instance: createWorkspaceInstance() };

let host: HTMLDivElement;
let root: Root;
let center: NotificationCenter;
let count: number;

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  center = createNotificationCenter();
  count = -1;
});
afterEach(() => act(() => root.unmount()));

/** The door and the board, as App and the controller wire them. */
function Deck({ boardShown }: { boardShown: boolean }) {
  count = useTasksUnread(center, ws);
  useBoardSeen(boardShown ? ws : null, center.markNotificationsReadWhere);
  return null;
}
const render = (boardShown = false) => act(() => root.render(createElement(Deck, { boardShown })));
const move = (taskId: string) =>
  act(() => {
    center.notify({ title: `${taskId} moved`, source: { type: "tasks", workspace: ws, taskId }, tag: `tasks:ws-1:${taskId}` });
  });

describe("the Tasks door over the notification center", () => {
  it("counts each task's unread event once — a second move of the same task replaces its line", () => {
    render();
    move("task-1");
    move("task-2");
    move("task-1");
    expect(count).toBe(2);
  });

  it("reading in the bell clears the door: one read state, not two", () => {
    render();
    move("task-1");
    const [entry] = center.getNotifications();
    act(() => center.markNotificationRead(entry.id));
    expect(count).toBe(0);
  });

  it("the board coming on screen clears the door, and a later move lights it again", () => {
    render();
    move("task-1");
    render(true);
    expect(count).toBe(0);
    render(false);
    move("task-2");
    expect(count).toBe(1);
  });
});
