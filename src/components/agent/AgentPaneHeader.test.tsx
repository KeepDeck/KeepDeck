// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneHeaderView } from "../../presentation/paneHeaderView";
import {
  AgentPaneHeader,
  type AgentPaneHeaderProps,
} from "./AgentPaneHeader";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;


const baseProps: AgentPaneHeaderProps = {
  paneId: "pane-1",
  title: "Claude 1",
  keyboardFocusEnabled: true,
  focused: false,
  solo: false,
  view: { status: null, stateWord: null, role: null, ctx: null },
  onRename: () => {},
  onToggleFocus: () => {},
  onClose: () => {},
};

const view = (over: Partial<PaneHeaderView> = {}): PaneHeaderView => ({
  ...baseProps.view,
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

  it("leads with the status dot, its words in the tooltip, and maps the tone to a class", () => {
    render({ view: view({ status: { tone: "working", label: "Working", tooltip: "Working · now" } }) });
    const dot = host.querySelector<HTMLElement>(".pane__status")!;
    expect(dot.className).toBe("pane__status pane__status--working");
    expect(dot.textContent).toBe("");
    expect(dot.title).toBe("Working · now");
    // First in the identity: how the agent is doing reads before who it is.
    expect(host.querySelector(".pane__identity")!.firstElementChild).toBe(dot);

    render();
    expect(host.querySelector(".pane__status")).toBeNull();
  });

  it("says the state in words only when the view hands it a word", () => {
    const status = { tone: "waiting" as const, label: "Needs approval", tooltip: "" };
    render({ view: view({ status, stateWord: "Needs approval" }) });
    const word = host.querySelector<HTMLElement>(".pane__state")!;
    expect(word.textContent).toBe("Needs approval");
    expect(word.className).toBe("pane__state pane__state--waiting");

    render({ view: view({ status }) });
    expect(host.querySelector(".pane__state")).toBeNull();
  });

  it("shows context as a number with its level class, only when the view has it", () => {
    render({ view: view({ ctx: { label: "82%", title: "Context 82% used", level: "warn" } }) });
    const ctx = host.querySelector<HTMLElement>(".pane__ctx")!;
    expect(ctx.textContent).toBe("82%");
    expect(ctx.className).toBe("pane__ctx pane__ctx--warn");
    expect(ctx.title).toBe("Context 82% used");

    render();
    expect(host.querySelector(".pane__ctx")).toBeNull();
  });

  it("carries no branch: the branch is the team's, said once above the deck", () => {
    render({ view: view({ role: { text: "impl-1", title: "" } }) });
    expect(host.querySelector(".pane__branch")).toBeNull();
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
    // The shared field's look, not a pane-private copy of it.
    expect(input.classList.contains("rename-input")).toBe(true);

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

  it("wears its role as a reading, not a door", () => {
    // The role is the address teammates use, so the header says it. It
    // opens nothing: a role is picked when the member is added, and the
    // pane's team is the one the stage has open.
    render({ view: view({ role: { text: "impl-1", title: "impl-1 on team api" } }) });
    const role = host.querySelector<HTMLElement>(".pane__role")!;
    expect(role.textContent).toBe("impl-1");
    expect(role.title).toBe("impl-1 on team api");
    expect(role.closest("button")).toBeNull();
  });

  it("shows no badge for a pane on no team", () => {
    render();
    expect(host.querySelector(".pane__role")).toBeNull();
  });
});
