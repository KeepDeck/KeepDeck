// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneHeaderView } from "../../presentation/paneHeaderView";
import {
  AgentPaneHeader,
  type AgentPaneHeaderProps,
} from "./AgentPaneHeader";
import { present } from "@keepdeck/plugin-api/testing";


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
    const dot = present(host.querySelector<HTMLElement>(".pane__status"), "the .pane__status element");
    expect(dot.className).toBe("pane__status pane__status--working");
    expect(dot.textContent).toBe("");
    expect(dot.title).toBe("Working · now");
    // First in the identity: how the agent is doing reads before who it is.
    expect(present(host.querySelector(".pane__identity"), "the .pane__identity element").firstElementChild).toBe(dot);

    render();
    expect(host.querySelector(".pane__status")).toBeNull();
  });

  it("says the state in words only when the view hands it a word", () => {
    const status = { tone: "waiting" as const, label: "Needs approval", tooltip: "" };
    render({ view: view({ status, stateWord: "Needs approval" }) });
    const word = present(host.querySelector<HTMLElement>(".pane__state"), "the .pane__state element");
    expect(word.textContent).toBe("Needs approval");
    expect(word.className).toBe("pane__state pane__state--waiting");

    render({ view: view({ status }) });
    expect(host.querySelector(".pane__state")).toBeNull();
  });

  it("shows context as a number with its level class, only when the view has it", () => {
    render({ view: view({ ctx: { label: "82%", title: "Context 82% used", level: "warn" } }) });
    const ctx = present(host.querySelector<HTMLElement>(".pane__ctx"), "the .pane__ctx element");
    expect(ctx.textContent).toBe("82%");
    expect(ctx.className).toBe("pane__ctx pane__ctx--warn");
    expect(ctx.title).toBe("Context 82% used");

    render();
    expect(host.querySelector(".pane__ctx")).toBeNull();
  });

  it("names the role after the title, and reads context as plain text left of YOLO", () => {
    render({
      yolo: true,
      view: view({
        role: { text: "lead", title: "" },
        ctx: { label: "49%", title: "Context 49% used", level: "ok" },
      }),
    });
    // The role is identity: after the title, led by a silent separator it
    // carries inside itself (so the ladder never counts a separate item).
    const identity = [...present(host.querySelector(".pane__identity"), "the .pane__identity element").children].map(
      (el) => el.className.split(" ")[0],
    );
    expect(identity.slice(-2)).toEqual(["pane__title", "pane__role"]);
    const sep = present(host.querySelector(".pane__role > .pane__sep"), "the .pane__role > .pane__sep element");
    expect(sep.getAttribute("aria-hidden")).toBe("true");
    // Context is the session's reading, not its name: in the cluster, just
    // before the bolt.
    const actions = [...present(host.querySelector(".pane__actions"), "the .pane__actions element").children].map(
      (el) => el.className.split(" ")[0],
    );
    expect(actions.indexOf("pane__ctx")).toBe(actions.indexOf("yolo-mark") - 1);
  });

  it("carries no branch: the branch is the team's, said once above the deck", () => {
    render({ view: view({ role: { text: "impl-1", title: "" } }) });
    expect(host.querySelector(".pane__branch")).toBeNull();
  });

  it("renames inline: double-click edits, Enter commits, Escape abandons", () => {
    const onRename = vi.fn();
    render({ onRename });
    const title = present(host.querySelector<HTMLElement>(".pane__title"), "the .pane__title element");
    act(() =>
      title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = present(host.querySelector<HTMLInputElement>(".pane__rename"), "the .pane__rename element");
    expect(input.value).toBe("Claude 1");
    // The shared field's look, not a pane-private copy of it.
    expect(input.classList.contains("rename-input")).toBe(true);

    act(() => {
      // Through the native setter: React's value tracker dedupes a plain
      // `.value =` write and would swallow the input event.
      present(present(Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ), "the value setter").set, "the value setter").call(input, "Renamed");
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
    const role = present(host.querySelector<HTMLElement>(".pane__role"), "the .pane__role element");
    expect(present(role.querySelector(".pane__role-text"), "the .pane__role-text element").textContent).toBe("impl-1");
    expect(role.title).toBe("impl-1 on team api");
    expect(role.closest("button")).toBeNull();
  });

  it("shows no badge for a pane on no team", () => {
    render();
    expect(host.querySelector(".pane__role")).toBeNull();
  });
});
