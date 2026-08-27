// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeckBar, type DeckBarProps } from "./DeckBar";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The bell owns its own data and is exercised by its own tests; standing it
// up here would drag a notification centre into questions about which button
// calls which callback.
vi.mock("../notifications/NotificationBell", () => ({
  NotificationBell: () => createElement("span", { "data-bell": "" }),
}));

const BASE: DeckBarProps = {
  railCollapsed: false,
  onToggleRail: () => {},
  workspaceName: null,
  canAddAgent: true,
  addAgentTitle: "Add agent",
  onAddAgent: () => {},
  onAddTeam: null,
  dock: null,
  pluginActions: [],
  canOpenDialog: true,
  onOpenStats: () => {},
  onOpenSkills: () => {},
  onOpenSettings: () => {},
  notifications: null,
};

describe("DeckBar", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (props: Partial<DeckBarProps> = {}) =>
    act(() => root.render(createElement(DeckBar, { ...BASE, ...props })));

  const byLabel = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const byText = (text: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === text,
    );

  it("draws nothing for a control the caller left out", () => {
    // Presence is the composition root's decision, and the bar's only say in
    // it is a null check — so a bar handed nothing optional shows exactly the
    // controls that are never optional.
    render();
    expect(byText("+ Team")).toBeUndefined();
    expect(byLabel("Toggle dock panel")).toBeNull();
    expect(host.querySelector("[data-bell]")).toBeNull();
    expect(byText("+ Agent")).toBeDefined();
  });

  it("says nothing about what is merely true", () => {
    // Quota, the agent count and a waiting update belong to the status strip.
    // The bar answering both kinds at once is the thing this split undid, so
    // the absence is worth a test rather than a comment.
    render();
    expect(host.querySelector(".deck__status")).toBeNull();
    expect(host.textContent).not.toMatch(/pane/);
  });

  it("routes each control to its own callback", () => {
    // The failure this exists for: nine buttons extracted in one move, and a
    // crossed pair looks perfectly fine until somebody presses it.
    const calls: string[] = [];
    render({
      onToggleRail: () => calls.push("rail"),
      onAddAgent: () => calls.push("agent"),
      onAddTeam: () => calls.push("team"),
      onOpenStats: () => calls.push("stats"),
      onOpenSkills: () => calls.push("skills"),
      onOpenSettings: () => calls.push("settings"),
      dock: { open: false, onToggle: () => calls.push("dock") },
    });
    act(() => byLabel("Toggle workspaces panel")?.click());
    act(() => byText("+ Agent")?.click());
    act(() => byText("+ Team")?.click());
    act(() => byLabel("Toggle dock panel")?.click());
    act(() => byLabel("Open statistics")?.click());
    act(() => byLabel("Open skills")?.click());
    act(() => byLabel("Open settings")?.click());
    expect(calls).toEqual([
      "rail",
      "agent",
      "team",
      "dock",
      "stats",
      "skills",
      "settings",
    ]);
  });

  it("gates the dialog destinations without touching the other controls", () => {
    // `canOpenDialog` is the modal layer's answer, and it has nothing to say
    // about adding an agent — that refusal has its own reason and its own
    // tooltip.
    render({ canOpenDialog: false });
    expect(byLabel("Open statistics")?.disabled).toBe(true);
    expect(byLabel("Open skills")?.disabled).toBe(true);
    expect(byLabel("Open settings")?.disabled).toBe(true);
    expect(byText("+ Agent")?.disabled).toBe(false);
    expect(byLabel("Toggle workspaces panel")?.disabled).toBe(false);
  });

  it("names a plugin action by its title and falls back to its initial", () => {
    // `title` is the contract's accessible name, and an icon is optional —
    // a contribution without one still has to be identifiable.
    const run = vi.fn();
    render({
      pluginActions: [
        { pluginId: "keepdeck.git", entry: { id: "sync", title: "Sync", run } },
      ],
    });
    const button = byLabel("Sync");
    expect(button?.textContent).toBe("S");
    act(() => button?.click());
    expect(run).toHaveBeenCalledOnce();
  });

  it("names the workspace only when the rail is not saying it", () => {
    render({ railCollapsed: false, workspaceName: null });
    expect(host.querySelector(".deck__active-ws")).toBeNull();
    render({ railCollapsed: true, workspaceName: "Личный проект" });
    expect(host.querySelector(".deck__active-ws")?.textContent).toBe(
      "Личный проект",
    );
  });
});
