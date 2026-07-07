// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real TerminalPane mounts xterm (canvas + Tauri IPC) — irrelevant to the
// header and unmountable under happy-dom. Stub it (as a spy: the provisioning
// cards must NOT mount a terminal) so the pane renders in isolation.
vi.mock("../terminal/TerminalPane", () => ({
  TerminalPane: vi.fn(() => null),
}));

import { TerminalPane } from "../terminal/TerminalPane";
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

  it("renders a runtime git badge when provided", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          gitBadge: { label: "main", title: "main" },
        }),
      ),
    );

    const badge = document.querySelector<HTMLElement>(".pane__branch");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("main");
    expect(badge!.title).toBe("main");
  });
});

describe("AgentPane — provisioning cards", () => {
  let host: HTMLElement;
  let root: Root;

  const intent = {
    repo: "/repo",
    baseDir: "/wt",
    branch: "kd/deck/2",
    workspace: "deck",
    index: 2,
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(TerminalPane).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("renders the creating card — location line, animation, and NO terminal", () => {
    act(() =>
      root.render(
        createElement(AgentPane, { ...baseProps, provisioning: intent }),
      ),
    );

    expect(document.body.textContent).toContain("Creating worktree…");
    // The intent's branch and target folder, on one muted line.
    expect(document.body.textContent).toContain("kd/deck/2 · /wt");
    expect(document.querySelector(".pane__provision-bar")).not.toBeNull();
    expect(document.querySelector(".pane__provision-pulse")).not.toBeNull();
    // No PTY may spawn until the worktree exists.
    expect(TerminalPane).not.toHaveBeenCalled();
  });

  it("renders the failed card with the error and fires onRetryProvision", () => {
    const onRetryProvision = vi.fn();
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          provisioning: { ...intent, error: "fatal: boom" },
          onRetryProvision,
        }),
      ),
    );

    expect(document.body.textContent).toContain("Worktree failed");
    expect(document.body.textContent).toContain("fatal: boom");
    // Failed, not creating: the animation is gone.
    expect(document.querySelector(".pane__provision-bar")).toBeNull();
    expect(TerminalPane).not.toHaveBeenCalled();

    const retry = document.querySelector<HTMLButtonElement>(
      ".pane__dormant-action",
    );
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toBe("Retry");
    act(() => retry!.click());
    expect(onRetryProvision).toHaveBeenCalledTimes(1);
  });

  it("hides the cwd launch action while provisioning — the fallback cwd is not this pane's folder", () => {
    act(() =>
      root.render(
        createElement(AgentPane, { ...baseProps, provisioning: intent }),
      ),
    );

    expect(document.querySelector(".pane__open")).toBeNull();
  });
});
