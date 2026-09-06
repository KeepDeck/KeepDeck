// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateAction } from "../../app/updateAction";
import { BAR_TIP_DELAY_MS } from "../../ui/TipButton";
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
  level: { kind: "teams", onAddTeam: () => {} },
  dock: null,
  pluginActions: [],
  canOpenDialog: true,
  onOpenStats: () => {},
  onOpenSkills: () => {},
  onOpenArtifacts: null,
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
  const pluginRow = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      pluginId: "keepdeck.demo",
      entry: { id: `p${i}`, title: `p${i}`, run: () => {} },
    }));

  it("draws nothing for a control the caller left out", () => {
    // Presence is the composition root's decision, and the bar's only say in
    // it is a null check — so a bar handed nothing optional shows exactly the
    // controls that are never optional.
    render({ level: { kind: "teams", onAddTeam: null } });
    expect(byText("+ Team")).toBeUndefined();
    expect(byLabel("Toggle dock panel")).toBeNull();
    expect(host.querySelector("[data-bell]")).toBeNull();
    // The artifacts door is one of these: the feature is off by default,
    // and a door to a feature that is not running leads to a refusal.
    expect(byLabel("Open artifacts")).toBeNull();
    render();
    expect(byText("+ Team")).toBeDefined();
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

  it("gives quota the middle zone, alone", () => {
    // Pinned left it sat above the rail's column and read as the rail's own
    // heading; pinned right it queued behind the verbs. The centre belongs to
    // nothing else, which is the whole reason it can hold this — so "alone"
    // is asserted with the one control that used to share it present.
    render({
      workspaceName: "Personal project",
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
    expect(order.indexOf("Update available")).toBe(0);
    expect(order.indexOf("+ Team")).toBe(1);
    // Its own group, so Create neither gains nor loses a neighbour when the
    // update comes and goes.
    expect(byText("Update available")!.closest(".bar__group")).not.toBe(
      byText("+ Team")!.closest(".bar__group"),
    );
  });

  it("routes each control to its own callback", () => {
    // The failure this exists for: nine controls rearranged in one move, and
    // a crossed pair looks perfectly fine until somebody presses it.
    const calls: string[] = [];
    render({
      onToggleRail: () => calls.push("rail"),
      level: { kind: "teams", onAddTeam: () => calls.push("team") },
      onOpenStats: () => calls.push("stats"),
      onOpenSkills: () => calls.push("skills"),
      onOpenArtifacts: () => calls.push("artifacts"),
      onOpenSettings: () => calls.push("settings"),
      dock: { open: false, onToggle: () => calls.push("dock") },
    });
    act(() => byLabel("Toggle workspaces panel")?.click());
    act(() => byLabel("Start a team")?.click());
    act(() => byLabel("Toggle dock panel")?.click());
    act(() => byLabel("Open statistics")?.click());
    act(() => byLabel("Open skills")?.click());
    act(() => byLabel("Open artifacts")?.click());
    act(() => byLabel("Open settings")?.click());
    expect(calls).toEqual([
      "rail",
      "team",
      "dock",
      "stats",
      "skills",
      "artifacts",
      "settings",
    ]);
    // And inside a team, the level's own two doors.
    render({
      level: {
        kind: "team",
        name: "api",
        branch: "kd/api",
        onBack: () => calls.push("back"),
        canAddMember: true,
        addMemberTitle: "Add a member",
        onAddMember: () => calls.push("member"),
      },
    });
    act(() => byLabel("Back to teams")?.click());
    act(() => byLabel("Add a member")?.click());
    expect(calls.slice(-2)).toEqual(["back", "member"]);
  });

  it("inside a team, says where you are and offers a member — one door per level, no menu", () => {
    // The rail says nothing about a team, so the bar does: the way back, the
    // name, the branch. And the create control is a plain button either
    // way: the level already chose what "new" means.
    render({
      level: {
        kind: "team",
        name: "api",
        branch: "kd/api",
        onBack: () => {},
        canAddMember: true,
        addMemberTitle: "Add a member",
        onAddMember: () => {},
      },
    });
    const left = host.querySelector(".deck__bar-left")!;
    expect(left.querySelector(".deck__team-name")?.textContent).toBe("api");
    expect(left.querySelector(".deck__team-branch")?.textContent).toContain("kd/api");
    expect(byLabel("Back to teams")).not.toBeNull();
    expect(byText("+ Member")).toBeDefined();
    expect(byText("+ Team")).toBeUndefined();
    expect(byLabel("Create")).toBeNull();
    // At the teams level none of that is said, and the door is the team's.
    render();
    expect(host.querySelector(".deck__team-name")).toBeNull();
    expect(byLabel("Back to teams")).toBeNull();
    expect(byText("+ Member")).toBeUndefined();
    expect(byText("+ Team")).toBeDefined();
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
      level: {
        kind: "team",
        name: "api",
        branch: null,
        onBack: () => {},
        canAddMember: false,
        addMemberTitle: "Max 16 agents on a team",
        onAddMember: () => {},
      },
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
    expect(byText("+ Team")?.disabled).toBe(false);
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
    render({ railCollapsed: true, workspaceName: "Personal project" });
    expect(host.querySelector(".deck__active-ws")?.textContent).toBe(
      "Personal project",
    );
  });
});
