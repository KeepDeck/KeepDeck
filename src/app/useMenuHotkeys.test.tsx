// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import * as menu from "../ipc/menu";
import { useMenuHotkeys, type MenuActions } from "./useMenuHotkeys";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const handlers = new Map<string, () => void>();
vi.mock("../ipc/menu", async (original) => ({
  ...(await original<typeof import("../ipc/menu")>()),
  onMenuEvent: (event: string, handler: () => void) => {
    handlers.set(event, handler);
    return Promise.resolve(() => handlers.delete(event));
  },
}));

describe("useMenuHotkeys", () => {
  it("routes every menu event to its own action", async () => {
    const calls: string[] = [];
    const actions = Object.fromEntries(
      (
        ["newWorkspace", "newAgent", "closeAgent", "suspendAgent", "toggleMaximize", "openSettings"] as const
      ).map((name) => [name, () => calls.push(name)]),
    ) as unknown as MenuActions;
    function Probe() {
      useMenuHotkeys(actions);
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(Probe)));
    const pairs: [string, string][] = [
      [menu.NEW_WORKSPACE_EVENT, "newWorkspace"],
      [menu.NEW_AGENT_EVENT, "newAgent"],
      [menu.CLOSE_AGENT_EVENT, "closeAgent"],
      [menu.SUSPEND_AGENT_EVENT, "suspendAgent"],
      [menu.TOGGLE_MAXIMIZE_EVENT, "toggleMaximize"],
      [menu.SETTINGS_EVENT, "openSettings"],
    ];
    for (const [event] of pairs) handlers.get(event)?.();
    expect(calls).toEqual(pairs.map(([, action]) => action));
    act(() => root.unmount());
  });
});
