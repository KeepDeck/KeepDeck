// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateAction } from "../../app/updateAction";
import { BAR_TIP_DELAY_MS } from "../../ui/TipButton";
import { DeckBar, type DeckBarProps } from "./DeckBar";
import type { BarLevel } from "../../presentation/barView";

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
const bellProps = vi.fn();
vi.mock("../notifications/NotificationBell", () => ({
  NotificationBell: (props: unknown) => {
    bellProps(props);
    return createElement("span", { "data-bell": "" });
  },
}));

const TEAM: BarLevel = {
  kind: "team",
  name: "api",
  branch: "kd/api",
  canAddMember: true,
  addMemberTitle: "Add a member",
  onAddMember: () => {},
};

const WORKSPACE: NonNullable<DeckBarProps["workspace"]> = {
  view: { id: "ws-1", name: "Personal project", moveUpTo: null, moveDownTo: 1 },
  onRename: () => {},
  onMove: () => {},
  onClose: () => {},
  onUp: () => {},
};

const BASE: DeckBarProps = {
  workspace: WORKSPACE,
  agents: [],
  usageLiveAgents: new Set(),
  updateAction: null,
  onUpdateAction: () => {},
  level: TEAM,
  dock: null,
  pluginActions: [],
  canOpenDialog: true,
  onOpenStats: () => {},
  onOpenSkills: () => {},
  onOpenMcp: () => {},
  onOpenArtifacts: null,
  onOpenTasks: null,
  onOpenSettings: () => {},
  needsYou: { rows: [], onOpen: () => {} },
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
  const pluginRow = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      pluginId: "keepdeck.demo",
      entry: { id: `p${i}`, title: `p${i}`, run: () => {} },
    }));

  it("mounts the attention control among the places, after statistics, whatever the settings", () => {
    // Who needs you is live state, not a notification preference: the
    // control decides for itself whether it has anything to say, so the bar
    // hands it the rows even with the notification list off.
    bellProps.mockClear();
    render();
    const bell = host.querySelector("[data-bell]")!;
    expect(bell.closest(".bar__group")).toBe(byLabel("Open skills")!.closest(".bar__group"));
    expect(bell.previousElementSibling?.contains(byLabel("Open statistics"))).toBe(true);
    expect(bellProps).toHaveBeenLastCalledWith({
      needsYou: BASE.needsYou,
      notifications: null,
    });
  });

  it("draws nothing for a control the caller left out", () => {
    // Presence is the composition root's decision, and the bar's only say in
    // it is a null check — so a bar handed nothing optional shows exactly the
    // controls that are never optional.
    render({ level: { kind: "teams", onAddTeam: null }, workspace: null });
    expect(byText("+ Member")).toBeUndefined();
    expect(byText("+ Team")).toBeUndefined();
    expect(host.querySelector(".deck__ws")).toBeNull();
    expect(byLabel("Toggle dock panel")).toBeNull();
    // The artifacts door is one of these: the feature is off by default,
    // and a door to a feature that is not running leads to a refusal.
    expect(byLabel("Open artifacts")).toBeNull();
    render();
    expect(byText("+ Member")).toBeDefined();
  });

  it("carries no pane count and no build number", () => {
    // Both were answered elsewhere already — the panes are on screen, and
    // the build sits at the strip's foot. They
    // were removed rather than relocated, and their absence is the point of
    // the whole rearrangement, so it is worth an assertion.
    render();
    expect(host.querySelector(".deck__status")).toBeNull();
    expect(host.textContent).not.toMatch(/pane/);
    expect(host.textContent).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("gives quota the middle zone, alone", () => {
    // Pinned left it sat above the rail's column and read as the rail's own
    // heading; pinned right it queued behind the verbs. The centre belongs to
    // nothing else, which is the whole reason it can hold this — so "alone"
    // is asserted with the one control that used to share it present.
    render({
      updateAction: {
        label: "Update available",
        title: "Version 0.22.0 is available",
        disabled: false,
        action: { kind: "openUpdatesSettings" },
      },
    });
    expect(
      host.querySelector(".deck__bar-center [data-usage]"),
    ).not.toBeNull();
    expect(host.querySelector(".deck__bar-left [data-usage]")).toBeNull();
    expect(host.querySelector(".deck__bar-right [data-usage]")).toBeNull();
    expect(
      host.querySelector(".deck__bar-center")?.childElementCount,
    ).toBe(1);
    // The project stays on the left, where "where am I" is answered.
    expect(host.querySelector(".deck__bar-left")?.textContent).toContain(
      "Personal project",
    );
  });

  it("stands the update control among the verbs, in front of Create", () => {
    // An update is something to DO, so it belongs to the right-hand run and
    // not beside a reading of the fleet. Order is the assertion: Create keeps
    // its place against the panels, and the update leads.
    render({
      updateAction: {
        label: "Update available",
        title: "Version 0.22.0 is available",
        disabled: false,
        action: { kind: "openUpdatesSettings" },
      },
    });
    const right = host.querySelector(".deck__bar-right")!;
    const order = Array.from(right.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    // The attention control (mocked here) leads; the update comes next.
    expect(order.indexOf("Update available")).toBe(0);
    expect(order.indexOf("+ Member")).toBe(1);
    // Its own group, so Create neither gains nor loses a neighbour when the
    // update comes and goes.
    expect(byText("Update available")!.closest(".bar__group")).not.toBe(
      byText("+ Member")!.closest(".bar__group"),
    );
  });

  it("the tasks door is its glyph alone — no count; task news is the bell's", () => {
    render({ onOpenTasks: () => {} });
    expect(byLabel("Open tasks")?.textContent ?? "").not.toMatch(/\d/);
    expect(document.querySelector(".tasks-door__count")).toBeNull();
    render({ onOpenTasks: null });
    expect(byLabel("Open tasks")).toBeFalsy();
  });

  it("routes each control to its own callback", () => {
    // The failure this exists for: nine controls rearranged in one move, and
    // a crossed pair looks perfectly fine until somebody presses it.
    const calls: string[] = [];
    render({
      workspace: { ...WORKSPACE, onUp: () => calls.push("back") },
      level: { ...TEAM, onAddMember: () => calls.push("member") } as BarLevel,
      onOpenStats: () => calls.push("stats"),
      onOpenSkills: () => calls.push("skills"),
      onOpenMcp: () => calls.push("mcp"),
      onOpenArtifacts: () => calls.push("artifacts"),
      onOpenTasks: () => calls.push("tasks"),
      onOpenSettings: () => calls.push("settings"),
      dock: { open: false, onToggle: () => calls.push("dock") },
    });
    act(() => byLabel("Back to the teams of Personal project")?.click());
    act(() => byLabel("Add a member")?.click());
    act(() => byLabel("Toggle dock panel")?.click());
    act(() => byLabel("Open statistics")?.click());
    act(() => byLabel("Open skills")?.click());
    act(() => byLabel("Open MCP servers")?.click());
    act(() => byLabel("Open artifacts")?.click());
    act(() => byLabel("Open tasks")?.click());
    act(() => byLabel("Open settings")?.click());
    expect(calls).toEqual([
      "back",
      "member",
      "dock",
      "stats",
      "skills",
      "mcp",
      "artifacts",
      "tasks",
      "settings",
    ]);
    // At the teams level the one door is a new team.
    render({ level: { kind: "teams", onAddTeam: () => calls.push("team") } });
    act(() => byLabel("Start a team")?.click());
    expect(calls[calls.length - 1]).toBe("team");
  });

  it("inside a team, says where you are and offers a member — one door per level, no menu", () => {
    render();
    const left = host.querySelector(".deck__bar-left")!;
    expect(left.querySelector(".deck__ws-name")?.textContent).toBe("Personal project");
    expect(left.querySelector(".deck__team-name")?.textContent).toBe("api");
    expect(left.querySelector(".deck__team-branch")?.textContent).toContain("kd/api");
    expect(byLabel("Back to the teams of Personal project")).not.toBeNull();
    // A breadcrumb: the workspace's name is the way back, the team follows it.
    expect(host.querySelector(".deck__crumbs .deck__crumb-sep")).not.toBeNull();
    expect(byText("+ Member")).toBeDefined();
    expect(byText("+ Team")).toBeUndefined();
    // At the teams level none of that is said, and the door is the team's;
    // the workspace's name is only a name (the controller hands no way up).
    render({ level: { kind: "teams", onAddTeam: () => {} }, workspace: { ...WORKSPACE, onUp: null } });
    expect(host.querySelector(".deck__team-name")).toBeNull();
    expect(byLabel("Back to the teams of Personal project")).toBeNull();
    expect(byText("+ Member")).toBeUndefined();
    expect(byText("+ Team")).toBeDefined();
    // The workspace is named at both levels.
    expect(host.querySelector(".deck__ws-name")?.textContent).toBe("Personal project");
  });

  it("keeps the open team's name recoverable when it does not fit", () => {
    // With the team list hidden, this is the one place the deck names the
    // open team, and a role badge answers "which teammate", not "which
    // team". So an ellipsized name here must be recoverable.
    // Asserted through the app's own tip rather than a `title` attribute,
    // because a `title` is what this WebView draws nothing for: the check has
    // to be that something SHOWS, or it pins the very trap TipButton exists
    // to document.
    const name = "a team whose name is far too long for two hundred and forty pixels";
    render({ level: { ...TEAM, name } as BarLevel });
    vi.useFakeTimers();
    try {
      act(() => {
        host
          .querySelector(".deck__team-name")!
          .closest(".kd-tip__anchor")!
          .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      act(() => void vi.advanceTimersByTime(BAR_TIP_DELAY_MS));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(name);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the update control's own words and its own action", () => {
    // The bar decides nothing about updates — it is handed a view and hands
    // back the action by name. Which means the whole seam is: does the label
    // reach the button, and does THAT action reach the callback.
    const acted: UpdateAction[] = [];
    render({
      updateAction: {
        label: "Update ready · Restart",
        title: "Update to 0.22.0 and restart",
        disabled: false,
        action: { kind: "restart" },
      },
      onUpdateAction: (action) => acted.push(action),
    });
    const button = byText("Update ready · Restart")!;
    expect(button).toBeDefined();
    act(() => button.click());
    expect(acted).toEqual([{ kind: "restart" }]);
  });

  it("does not act on an update step that is already running", () => {
    const acted: UpdateAction[] = [];
    render({
      updateAction: {
        label: "Downloading update…",
        title: "Version 0.22.0 is available",
        disabled: true,
        action: { kind: "openUpdatesSettings" },
      },
      onUpdateAction: (action) => acted.push(action),
    });
    const button = byText("Downloading update…")!;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(acted).toEqual([]);
  });

  it("says why a member is refused, in the control's own tip", () => {
    // A full team disables the door; the tip has to SAY why. Asserting that
    // an anchor exists would pass with any wording at all, this refusal
    // included by an empty one.
    render({
      level: { ...TEAM, branch: null, canAddMember: false, addMemberTitle: "Max 16 agents on a team" } as BarLevel,
    });
    expect(byText("+ Member")?.disabled).toBe(true);
    vi.useFakeTimers();
    try {
      act(() => {
        byText("+ Member")!
          .closest(".kd-tip__anchor")!
          .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      act(() => void vi.advanceTimersByTime(BAR_TIP_DELAY_MS));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        "Max 16 agents on a team",
      );
    } finally {
      vi.useRealTimers();
    }
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
    expect(byText("+ Member")?.disabled).toBe(false);
    expect(byLabel("Back to the teams of Personal project")?.disabled).toBe(false);
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

  it("renames, moves and closes the workspace from its crumb's menu", () => {
    const calls: unknown[] = [];
    render({
      workspace: {
        ...WORKSPACE,
        onRename: (name) => calls.push(["rename", name]),
        onMove: (to) => calls.push(["move", to]),
        onClose: () => calls.push(["close"]),
      },
    });
    const items = () => [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    act(() => byLabel("Workspace Personal project actions")!.click());
    expect(items().map((i) => i.textContent)).toEqual(["Rename", "Move up", "Move down", "Close workspace"]);
    act(() => items()[2].click());
    act(() => byLabel("Workspace Personal project actions")!.click());
    act(() => items()[3].click());
    act(() => byLabel("Workspace Personal project actions")!.click());
    act(() => items()[0].click());
    const input = host.querySelector<HTMLInputElement>("input[aria-label='Workspace name']")!;
    expect(input.value).toBe("Personal project");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, " Work ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(calls).toEqual([["move", 1], ["close"], ["rename", "Work"]]);
  });

  it("renames the workspace on a double-click at the cards, never inside a team", () => {
    // Inside a team the name is the way back, and a double-click would first
    // fire the click that leaves the team.
    const renameField = () => host.querySelector("input[aria-label='Workspace name']");
    const dblclick = () =>
      act(() => {
        host.querySelector(".deck__ws-name")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
    render({ level: { kind: "teams", onAddTeam: null }, workspace: { ...WORKSPACE, onUp: null } });
    dblclick();
    expect(renameField()).not.toBeNull();
    render({ workspace: { ...WORKSPACE, view: { ...WORKSPACE.view, id: "ws-2" } } });
    dblclick();
    expect(renameField()).toBeNull();
  });
});
