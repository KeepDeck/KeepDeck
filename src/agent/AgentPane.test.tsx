// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real TerminalPane mounts xterm (canvas + Tauri IPC) — irrelevant to the
// header and unmountable under happy-dom. Stub it so the pane renders in
// isolation and we can assert on the header controls.
vi.mock("../terminal/TerminalPane", () => ({ TerminalPane: () => null }));

import { AgentPane } from "./AgentPane";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  paneId: "ws:1",
  title: "Claude 1",
  command: null,
  cwd: "/repo/work" as string | null,
  branch: null,
  visible: true,
  focused: false,
  collapsed: false,
  selected: false,
  solo: false,
  colSpan: 1,
  onSelect: () => {},
  onToggleFocus: () => {},
  onOpenInEditor: () => {},
  onClose: () => {},
  onRename: () => {},
  onTitle: () => {},
};

describe("AgentPane — open in VS Code", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("renders the text button and fires onOpenInEditor on click when a cwd is known", () => {
    const onOpenInEditor = vi.fn();
    act(() =>
      root.render(createElement(AgentPane, { ...baseProps, onOpenInEditor })),
    );

    const btn = document.querySelector<HTMLButtonElement>(".pane__open");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("Open in VSCode");

    act(() => btn!.click());
    expect(onOpenInEditor).toHaveBeenCalledTimes(1);
  });

  it("hides the button when there is no cwd — nothing to open", () => {
    act(() => root.render(createElement(AgentPane, { ...baseProps, cwd: null })));

    expect(document.querySelector(".pane__open")).toBeNull();
  });
});
