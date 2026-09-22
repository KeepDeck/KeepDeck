// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { NotificationWorkspace } from "../../domain/notifications";
import { createNotificationCenter, type NotificationCenter } from "../notificationCenter";
import { useBoardSeen } from "./useBoardSeen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ws1: NotificationWorkspace = { id: "ws-1", instance: createWorkspaceInstance() };
const ws2: NotificationWorkspace = { id: "ws-2", instance: createWorkspaceInstance() };

let host: HTMLDivElement;
let root: Root;
let center: NotificationCenter;

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  center = createNotificationCenter();
});
afterEach(() => act(() => root.unmount()));

const taskEvent = (workspace: NotificationWorkspace, taskId: string) =>
  center.notify({ title: `${taskId} moved`, source: { type: "tasks", workspace, taskId }, tag: `tasks:${workspace.id}:${taskId}` });

function Probe({ shown }: { shown: NotificationWorkspace | null }) {
  useBoardSeen(shown, center.markNotificationsReadWhere);
  return null;
}
const show = (shown: NotificationWorkspace | null) => act(() => root.render(createElement(Probe, { shown })));
const unread = () => center.getNotifications().filter((n) => n.readAt === undefined).map((n) => n.title);

describe("useBoardSeen", () => {
  it("boards coming on screen read their workspace's task notifications — and only those", () => {
    taskEvent(ws1, "task-1");
    taskEvent(ws2, "task-2");
    center.notify({ title: "pane", source: { type: "pane", workspace: ws1, paneId: "pane-1" } });
    show(null);
    expect(unread()).toEqual(["pane", "task-2 moved", "task-1 moved"]);
    show(ws1);
    expect(unread()).toEqual(["pane", "task-2 moved"]);
  });

  it("another workspace's boards taking their place read that workspace's too", () => {
    taskEvent(ws1, "task-1");
    taskEvent(ws2, "task-2");
    show(ws1);
    show(ws2);
    expect(unread()).toEqual([]);
  });

  it("a board re-made under the same id is another lifetime: its old entries are not this one's", () => {
    const stale = { id: "ws-1", instance: createWorkspaceInstance() };
    taskEvent(stale, "task-1");
    show(ws1);
    expect(unread()).toEqual(["task-1 moved"]);
  });
});
