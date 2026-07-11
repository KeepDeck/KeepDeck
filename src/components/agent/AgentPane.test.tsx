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
  hidden: false,
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

  it("places the VS Code button before the git branch badge", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          gitBadge: { label: "main", title: "main" },
        }),
      ),
    );

    const actions = document.querySelector(".pane__actions");
    expect(actions?.children[0]?.className).toBe("pane__open");
    expect(actions?.children[1]?.className).toBe("pane__branch");
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

describe("AgentPane — the unavailable-agent card", () => {
  let host: HTMLElement;
  let root: Root;

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

  it("blocks the terminal (the spawn) and names the missing agent", () => {
    act(() =>
      root.render(
        createElement(AgentPane, { ...baseProps, unavailableAgent: "gemini" }),
      ),
    );

    expect(document.body.textContent).toContain("Agent unavailable");
    expect(document.body.textContent).toContain("gemini");
    // Mounting the terminal is what spawns — the card must prevent it.
    expect(TerminalPane).not.toHaveBeenCalled();
  });

  it("wins over the dormant tile — the card explains WHY nothing wakes", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          unavailableAgent: "gemini",
          dormant: true,
        }),
      ),
    );

    expect(document.body.textContent).toContain("Agent unavailable");
    expect(document.body.textContent).not.toContain("Waking up");
  });
});

describe("AgentPane — minimize control", () => {
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

  const minimizeBtn = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Minimize Claude 1"]');

  it("shows the button only when onMinimize is provided, and fires it on click", () => {
    act(() => root.render(createElement(AgentPane, { ...baseProps })));
    expect(minimizeBtn()).toBeNull();

    const onMinimize = vi.fn();
    act(() => root.render(createElement(AgentPane, { ...baseProps, onMinimize })));
    const btn = minimizeBtn();
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });

  it("hides the button while the pane is maximized (restore first)", () => {
    act(() =>
      root.render(
        createElement(AgentPane, { ...baseProps, onMinimize: vi.fn(), focused: true }),
      ),
    );
    expect(minimizeBtn()).toBeNull();
  });

  it("a folded (list) pane shows a chevron and neither minimize nor maximize", () => {
    act(() =>
      root.render(
        createElement(AgentPane, { ...baseProps, folded: true, onMinimize: vi.fn() }),
      ),
    );
    expect(document.querySelector(".pane--folded")).not.toBeNull();
    expect(document.querySelector(".pane__fold-chevron")).not.toBeNull();
    expect(minimizeBtn()).toBeNull();
    expect(document.querySelector('[aria-label="Maximize Claude 1"]')).toBeNull();
    // Close still works from a folded row.
    expect(document.querySelector('[aria-label="Close Claude 1"]')).not.toBeNull();
  });
});

describe("AgentPane — folded-row interactions", () => {
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

  const mountFolded = (overrides: Record<string, unknown> = {}) => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          folded: true,
          onSelect,
          onClose,
          ...overrides,
        }),
      ),
    );
    return { onSelect, onClose };
  };

  it("clicking the header expands (selects) the row", () => {
    const { onSelect } = mountFolded();
    act(() =>
      document
        .querySelector<HTMLElement>(".pane__bar")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSelect).toHaveBeenCalled();
  });

  it("the chevron is a real expand button, not decoration", () => {
    const { onSelect } = mountFolded();
    const chevron = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand Claude 1"]',
    );
    expect(chevron).not.toBeNull();
    expect(chevron!.getAttribute("aria-expanded")).toBe("false");
    act(() => chevron!.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("the close button acts WITHOUT expanding the row", () => {
    // A folded row's ✕ used to expand it first — reflowing the accordion
    // under the pointer (the click could even miss) and behind the confirm.
    const { onSelect, onClose } = mountFolded();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close Claude 1"]')!
        .click(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("mousedown alone never expands a folded row (no reflow under the pointer)", () => {
    const { onSelect } = mountFolded();
    act(() =>
      document
        .querySelector<HTMLElement>(".pane__bar")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("focus passing through a folded row's buttons does not expand it", () => {
    const { onSelect } = mountFolded();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close Claude 1"]')!
        .dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a NON-folded pane still selects on mousedown (grid behavior unchanged)", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(createElement(AgentPane, { ...baseProps, onSelect })),
    );
    act(() =>
      document
        .querySelector<HTMLElement>(".pane__bar")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(onSelect).toHaveBeenCalled();
  });
});
