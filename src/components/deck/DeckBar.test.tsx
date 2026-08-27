// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeckBar, type DeckBarProps } from "./DeckBar";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The bar's two live children own their own data and are exercised by their
// own tests; standing them up here would drag usage stores and a notification
// centre into questions about which control calls which callback.
vi.mock("../usage/UsageChips", () => ({
  UsageChips: () => createElement("span", { "data-usage": "" }),
}));
vi.mock("../notifications/NotificationBell", () => ({
  NotificationBell: () => createElement("span", { "data-bell": "" }),
}));

const BASE: DeckBarProps = {
  railCollapsed: false,
  onToggleRail: () => {},
  workspaceName: null,
  agents: [],
  usageLiveAgents: new Set(),
  updateAction: null,
  onUpdateAction: () => {},
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
  // Menus are portaled out of the bar's DOM, so they are found on the document.
  const menuItem = (text: string) =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === text);
  const pluginRow = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      pluginId: "keepdeck.demo",
      entry: { id: `p${i}`, title: `p${i}`, run: () => {} },
    }));

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

  it("carries no pane count and no build number", () => {
    // Both were answered elsewhere already — the rail numbers each workspace,
    // the panes are on screen, and the build sits in the rail's footer. They
    // were removed rather than relocated, and their absence is the point of
    // the whole rearrangement, so it is worth an assertion.
    render();
    expect(host.querySelector(".deck__status")).toBeNull();
    expect(host.textContent).not.toMatch(/pane/);
    expect(host.textContent).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("keeps quota on the left, with the project it belongs to", () => {
    // Facts on the left, verbs on the right — the arrangement that replaced a
    // second strip along the bottom.
    render({ workspaceName: "Личный проект" });
    const left = host.querySelector(".deck__bar-left")!;
    expect(left.querySelector("[data-usage]")).not.toBeNull();
    expect(left.textContent).toContain("Личный проект");
    expect(host.querySelector(".deck__bar-right [data-usage]")).toBeNull();
  });

  it("routes each control to its own callback", () => {
    // The failure this exists for: nine controls rearranged in one move, and
    // a crossed pair looks perfectly fine until somebody presses it.
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
    act(() => byLabel("Create")?.click());
    act(() => menuItem("Agent")?.click());
    act(() => byLabel("Create")?.click());
    act(() => menuItem("Team")?.click());
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

  it("collapses the create control when there is only one way to create", () => {
    // A menu of one puts a click in front of the app's commonest action and
    // gives nothing back for it.
    render({ onAddTeam: null });
    expect(byLabel("Create")).toBeNull();
    expect(byText("+ Agent")).toBeDefined();
  });

  it("keeps the plugin group from growing with the plugins installed", () => {
    // Three slots, and the control that opens the rest takes one of them —
    // so four contributions leave two drawn and two folded, and a hundred
    // leave the same two.
    render({ pluginActions: pluginRow(4) });
    expect(byLabel("p0")).not.toBeNull();
    expect(byLabel("p1")).not.toBeNull();
    expect(byLabel("p2")).toBeNull();
    const overflow = byLabel("More plugin actions");
    expect(overflow).not.toBeNull();
    act(() => overflow?.click());
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).map((item) => item.textContent),
    ).toEqual(["p2", "p3"]);
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
