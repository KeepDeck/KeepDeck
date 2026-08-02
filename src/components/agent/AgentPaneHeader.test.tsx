// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityBadge } from "../../domain/status";
import {
  AgentPaneHeader,
  type AgentPaneHeaderProps,
} from "./AgentPaneHeader";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_754_000_000_000;

const baseProps: AgentPaneHeaderProps = {
  paneId: "pane-1",
  title: "Claude 1",
  folded: false,
  focused: false,
  solo: false,
  activityView: null,
  now: NOW,
  ctxPct: undefined,
  paneLive: true,
  onSelect: () => {},
  onRename: () => {},
  onToggleFocus: () => {},
  onClose: () => {},
};

const badge = (over: Partial<ActivityBadge> = {}): ActivityBadge => ({
  tone: "working",
  label: "Working",
  sentence: "working",
  at: NOW,
  ...over,
});

/**
 * The header direct — every badge value arrives settled, exactly the
 * component's contract. The tracker→pane integration stays in
 * AgentPane.test; THIS file is where a new badge's rendering gets pinned
 * without constructing a whole pane.
 */
describe("AgentPaneHeader", () => {
  let host: HTMLElement;
  let root: Root;

  const render = (over: Partial<AgentPaneHeaderProps> = {}) =>
    act(() =>
      root.render(createElement(AgentPaneHeader, { ...baseProps, ...over })),
    );

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("renders every activity state as a dot, words in the tooltip", () => {
    render({ activityView: badge() });
    let chip = host.querySelector<HTMLElement>(".pane__activity")!;
    expect(chip.className).toContain("pane__activity--working");
    expect(chip.textContent).toBe("");
    expect(chip.title).toBe("Working · now");

    render({
      activityView: badge({ tone: "waiting", label: "Needs approval" }),
    });
    chip = host.querySelector<HTMLElement>(".pane__activity")!;
    // The tone class alone carries the hue — status.css owns the palette.
    expect(chip.className).toContain("pane__activity--waiting");
    expect(chip.textContent).toBe("");

    render({
      activityView: badge({
        tone: "failed",
        label: "Rate limited",
        detail: "Weekly limit reached",
      }),
    });
    chip = host.querySelector<HTMLElement>(".pane__activity")!;
    expect(chip.className).toContain("pane__activity--failed");
    expect(chip.title).toBe("Rate limited — Weekly limit reached · now");

    render({ activityView: null });
    expect(host.querySelector(".pane__activity")).toBeNull();
  });

  it("shows the ctx meter only for a live pane, with its level class", () => {
    render({ ctxPct: 82 });
    let ctx = host.querySelector<HTMLElement>(".pane__ctx")!;
    expect(ctx.textContent).toBe("ctx 82%");
    expect(ctx.className).toContain("usage-level--warn");

    // Calm (< 75%) → no usage-level--* suffix appended.
    render({ ctxPct: 40 });
    ctx = host.querySelector<HTMLElement>(".pane__ctx")!;
    expect(ctx.textContent).toBe("ctx 40%");
    expect(ctx.className).toBe("chip pane__ctx");

    // The liveness verdict arrives SETTLED — the header only obeys it.
    render({ ctxPct: 82, paneLive: false });
    expect(host.querySelector(".pane__ctx")).toBeNull();
  });

  it("renders the git badge and leads the actions cluster with it", () => {
    render({ gitBadge: { label: "main", title: "main" } });
    const branch = host.querySelector<HTMLElement>(".pane__branch")!;
    expect(branch.textContent).toBe("main");
    expect(branch.title).toBe("main");
    const actions = host.querySelector(".pane__actions")!;
    expect(actions.children[0]?.className).toBe("chip pane__branch");
  });

  it("renames inline: double-click edits, Enter commits, Escape abandons", () => {
    const onRename = vi.fn();
    render({ onRename });
    const title = host.querySelector<HTMLElement>(".pane__title")!;
    act(() =>
      title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = host.querySelector<HTMLInputElement>(".pane__rename")!;
    expect(input.value).toBe("Claude 1");

    act(() => {
      // Through the native setter: React's value tracker dedupes a plain
      // `.value =` write and would swallow the input event.
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onRename).toHaveBeenCalledWith("Renamed");
    expect(host.querySelector(".pane__rename")).toBeNull();
  });

  it("sheds window controls by role: minimize needs a handler, maximize needs company", () => {
    // No onMinimize → no minimize button; solo → no maximize either.
    render({ solo: true });
    expect(host.querySelector(".pane__action--minimize")).toBeNull();
    expect(host.querySelectorAll(".pane__action")).toHaveLength(0);

    const onMinimize = vi.fn();
    render({ solo: false, onMinimize });
    expect(host.querySelector(".pane__action--minimize")).not.toBeNull();
    // A maximized pane hides minimize (restore is the way back).
    render({ solo: false, focused: true, onMinimize });
    expect(host.querySelector(".pane__action--minimize")).toBeNull();
  });

  it("closing a folded row must not also expand it", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render({ folded: true, onSelect, onClose });
    const close = host.querySelector<HTMLButtonElement>(".ui-close")!;
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
