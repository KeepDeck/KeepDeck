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

import type { NormalizedUsage } from "@keepdeck/plugin-api";
import type { PaneIdle } from "../../domain/deck";
import { TerminalPane } from "../terminal/TerminalPane";
import {
  registerUsageNormalizer,
  reportUsage,
  resetUsageManager,
} from "../../app/usageManager";
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
  onClose: () => {},
  onRename: () => {},
  onTitle: () => {},
};

describe("AgentPane — header badges", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    resetUsageManager();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetUsageManager();
  });

  it("shows the context meter in the header from live pane usage", () => {
    registerUsageNormalizer(
      "claude",
      (payload) => (payload as { result: NormalizedUsage }).result,
    );
    reportUsage("ws:1", {
      agent: "claude",
      result: {
        account: null,
        pane: { agent: "claude", context: { usedPct: 82 }, reportedAt: 0 },
      },
    });
    act(() => root.render(createElement(AgentPane, baseProps)));

    const ctx = document.querySelector<HTMLElement>(".pane__ctx");
    expect(ctx).not.toBeNull();
    expect(ctx!.textContent).toBe("ctx 82%");
    // 82% is autocompact territory → amber, not calm.
    expect(ctx!.className).toContain("usage-level--warn");
  });

  it("shows no context meter when the pane reports no usage", () => {
    act(() => root.render(createElement(AgentPane, baseProps)));
    expect(document.querySelector(".pane__ctx")).toBeNull();
  });

  it("renders a calm context meter without a level class", () => {
    registerUsageNormalizer(
      "claude",
      (payload) => (payload as { result: NormalizedUsage }).result,
    );
    reportUsage("ws:1", {
      agent: "claude",
      result: {
        account: null,
        pane: { agent: "claude", context: { usedPct: 40 }, reportedAt: 0 },
      },
    });
    act(() => root.render(createElement(AgentPane, baseProps)));
    const ctx = document.querySelector<HTMLElement>(".pane__ctx");
    expect(ctx?.textContent).toBe("ctx 40%");
    // Calm (< 75%) → no usage-level--* suffix appended.
    expect(ctx?.className).toBe("chip pane__ctx");
  });

  it("hides the context meter on a non-live (idle) pane despite usage", () => {
    registerUsageNormalizer(
      "claude",
      (payload) => (payload as { result: NormalizedUsage }).result,
    );
    reportUsage("ws:1", {
      agent: "claude",
      result: {
        account: null,
        pane: { agent: "claude", context: { usedPct: 82 }, reportedAt: 0 },
      },
    });
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "waking", origin: "restore" } as const,
        }),
      ),
    );
    // A frozen ctx% must not read as live on a pane that isn't running.
    expect(document.querySelector(".pane__ctx")).toBeNull();
  });

  it.each([
    [
      "provisioning",
      { provisioning: { repo: "/r", baseDir: "/w", branch: "b", workspace: "w", index: 1 } },
    ],
    ["unavailable", { unavailableAgent: { kind: "no-plugin" as const, agent: "gemini" } }],
    ["plan-pending", { planPending: true }],
  ] as const)(
    "hides the context meter on a %s pane despite usage",
    (_label, override) => {
      registerUsageNormalizer(
        "claude",
        (payload) => (payload as { result: NormalizedUsage }).result,
      );
      reportUsage("ws:1", {
        agent: "claude",
        result: {
          account: null,
          pane: { agent: "claude", context: { usedPct: 82 }, reportedAt: 0 },
        },
      });
      act(() =>
        root.render(createElement(AgentPane, { ...baseProps, ...override })),
      );
      expect(document.querySelector(".pane__ctx")).toBeNull();
    },
  );

  it("hides the context meter once the pane's process has exited", () => {
    registerUsageNormalizer(
      "claude",
      (payload) => (payload as { result: NormalizedUsage }).result,
    );
    reportUsage("ws:1", {
      agent: "claude",
      result: {
        account: null,
        pane: { agent: "claude", context: { usedPct: 82 }, reportedAt: 0 },
      },
    });
    vi.mocked(TerminalPane).mockClear();
    act(() => root.render(createElement(AgentPane, baseProps)));
    expect(document.querySelector(".pane__ctx")).not.toBeNull(); // live → shown
    // The PTY exits → the now-frozen ctx% must go.
    const calls = vi.mocked(TerminalPane).mock.calls;
    const terminalProps = calls[calls.length - 1]?.[0];
    act(() => terminalProps?.onExit?.(0, false));
    expect(document.querySelector(".pane__ctx")).toBeNull();
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

  it("leads the actions cluster with the git branch badge", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          gitBadge: { label: "main", title: "main" },
        }),
      ),
    );

    const actions = document.querySelector(".pane__actions");
    expect(actions?.children[0]?.className).toBe("chip pane__branch");
  });

  it("can receive restored focus without entering the tab order", () => {
    act(() => root.render(createElement(AgentPane, baseProps)));

    const pane = document.querySelector<HTMLElement>("[data-pane-id='ws:1']")!;
    expect(pane.tabIndex).toBe(-1);
    act(() => pane.focus());
    expect(document.activeElement).toBe(pane);
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

});

describe("AgentPane — plan-error tile", () => {
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

  it("renders the error tile (not 'Waking up…') and fires onRetryPlan", () => {
    const onRetryPlan = vi.fn();
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          planError: true,
          onRetryPlan,
        }),
      ),
    );

    expect(document.body.textContent).toContain("Couldn't start this agent");
    // Not the planPending tile, and no terminal mounted.
    expect(document.body.textContent).not.toContain("Waking up");
    expect(TerminalPane).not.toHaveBeenCalled();

    const retry =
      document.querySelector<HTMLButtonElement>(".pane__dormant-action");
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toBe("Try again");
    act(() => retry!.click());
    expect(onRetryPlan).toHaveBeenCalledTimes(1);
  });

  it("does not render the error tile when planError is false (planPending path)", () => {
    act(() =>
      root.render(createElement(AgentPane, { ...baseProps, planPending: true })),
    );
    expect(document.body.textContent).not.toContain("Couldn't start this agent");
    expect(document.body.textContent).toContain("Waking up");
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
        createElement(AgentPane, {
          ...baseProps,
          unavailableAgent: { kind: "no-plugin", agent: "gemini" },
        }),
      ),
    );

    expect(document.body.textContent).toContain("Agent unavailable");
    expect(document.body.textContent).toContain("gemini");
    expect(document.body.textContent).toContain("No plugin provides");
    // Mounting the terminal is what spawns — the card must prevent it.
    expect(TerminalPane).not.toHaveBeenCalled();
  });

  it("names the missing CLI and the recovery gesture when the plugin is enabled but unavailable", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          unavailableAgent: {
            kind: "bin-missing",
            agent: "kimi",
            reason: 'agent "kimi" is not installed',
          },
        }),
      ),
    );

    // The exact composed sentence, not just substrings — a broken join or a
    // dropped suffix must fail this.
    expect(document.body.textContent).toContain(
      'agent "kimi" is not installed — install it, then re-enable the plugin in Settings → Plugins',
    );
    expect(document.body.textContent).not.toContain("No plugin provides");
    expect(TerminalPane).not.toHaveBeenCalled();
  });

  it("wins over the idle tile — the card explains WHY nothing wakes", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          unavailableAgent: { kind: "no-plugin", agent: "gemini" },
          idle: { reason: "waking", origin: "restore" } as const,
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

describe("AgentPane — manual restart after exit", () => {
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

  const mount = (overrides: Record<string, unknown> = {}) => {
    act(() =>
      root.render(createElement(AgentPane, { ...baseProps, ...overrides })),
    );
  };

  const reportExit = (code: number | null, replayed = false) => {
    const calls = vi.mocked(TerminalPane).mock.calls;
    const terminalProps = calls[calls.length - 1][0];
    act(() => terminalProps.onExit?.(code, replayed));
  };

  const actionButtons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(".pane__exit-action"),
    );

  it("forgets the exit when the pane stops — a resume must not come back veiled", () => {
    // Suspending is allowed on an exited pane, and neither suspend nor resume
    // remounts the component (no epoch bump, unlike a restart), so without an
    // explicit reset the exit card would paint over the terminal the resume
    // just brought back — with a Restart button that kills it again.
    mount({ onRestart: vi.fn() });
    reportExit(0);
    expect(document.querySelector(".pane__exit")).not.toBeNull();

    // Suspended: the card is replaced by the stopped one…
    mount({
      onRestart: vi.fn(),
      idle: { reason: "suspended", at: new Date().toISOString() },
      onResume: vi.fn(),
    });
    expect(document.querySelector(".pane__exit")).toBeNull();

    // …and resuming leaves a clean, live pane.
    vi.mocked(TerminalPane).mockClear();
    mount({ onRestart: vi.fn() });
    expect(document.querySelector(".pane__exit")).toBeNull();
    expect(actionButtons()).toHaveLength(0);
    expect(TerminalPane).toHaveBeenCalled();
  });

  it("shows no restart controls before exit and reports both exit-code forms", () => {
    mount({ onRestart: vi.fn() });

    expect(document.querySelector(".pane__exit")).toBeNull();
    expect(actionButtons()).toHaveLength(0);

    reportExit(17);
    expect(document.querySelector(".pane__exit")?.textContent).toContain(
      "exit code 17",
    );
    expect(actionButtons()).toHaveLength(1);

    reportExit(null);
    expect(document.querySelector(".pane__exit")?.textContent).toContain(
      "terminated",
    );
  });

  it("a replayed exit restores the card but never re-fires onExited", () => {
    const onExited = vi.fn();
    mount({ onExited, onRestart: vi.fn() });

    reportExit(137, true); // attachPane re-announcing after a remount
    expect(document.querySelector(".pane__exit")).not.toBeNull();
    expect(onExited).not.toHaveBeenCalled();

    reportExit(137, false); // the actual death does reach upstream
    expect(onExited).toHaveBeenCalledTimes(1);
    expect(onExited).toHaveBeenCalledWith(137);
  });

  it("a replayed spawn failure never re-fires onSpawnFailed — live only", () => {
    const onSpawnFailed = vi.fn();
    mount({ onSpawnFailed });
    const calls = vi.mocked(TerminalPane).mock.calls;
    const terminalProps = calls[calls.length - 1][0];

    act(() => terminalProps.onSpawnError?.("ENOENT", true)); // remount replay
    expect(onSpawnFailed).not.toHaveBeenCalled();

    act(() => terminalProps.onSpawnError?.("ENOENT", false)); // the real failure
    expect(onSpawnFailed).toHaveBeenCalledTimes(1);
    expect(onSpawnFailed).toHaveBeenCalledWith("ENOENT");
  });

  it("starts fresh from the primary action when no session can be resumed", () => {
    const onRestart = vi.fn();
    mount({ onRestart });
    reportExit(0);

    const buttons = actionButtons();
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Restart agent",
    ]);
    act(() => buttons[0].click());

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith("fresh");
  });

  it("resumes from the primary action and offers an explicit fresh alternative", () => {
    const onRestart = vi.fn();
    mount({ resumeSessionId: "sess-abc", onRestart });
    reportExit(2);

    const buttons = actionButtons();
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Restart agent",
      "Start new session",
    ]);
    act(() => buttons[0].click());

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith("resume");
  });

  it("uses fresh mode from the secondary action", () => {
    const onRestart = vi.fn();
    mount({ resumeSessionId: "sess-abc", onRestart });
    reportExit(2);

    act(() => actionButtons()[1].click());

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledWith("fresh");
  });

  it("guards an in-flight restart from repeated clicks", () => {
    const pending = new Promise<void>(() => {});
    const onRestart = vi.fn(() => pending);
    mount({ resumeSessionId: "sess-abc", onRestart });
    reportExit(0);

    const primary = actionButtons()[0];
    act(() => {
      primary.click();
      primary.click();
    });

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(actionButtons().every((button) => button.disabled)).toBe(true);
    expect(actionButtons()[0].textContent).toBe("Restarting…");
  });

  it("restores both choices when restart planning rejects", async () => {
    let rejectRestart: (reason: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, reject) => {
      rejectRestart = reject;
    });
    const onRestart = vi.fn(() => pending);
    mount({ resumeSessionId: "sess-abc", onRestart });
    reportExit(1);

    act(() => actionButtons()[0].click());
    expect(actionButtons().every((button) => button.disabled)).toBe(true);

    await act(async () => {
      rejectRestart(new Error("restart plan failed"));
      await Promise.resolve();
    });

    expect(actionButtons().every((button) => !button.disabled)).toBe(true);
    expect(actionButtons()[0].textContent).toBe("Restart agent");
    expect(document.querySelector("[role='alert']")?.textContent).toBe(
      "Restart failed",
    );
  });
});

describe("AgentPane — suspended / parked card", () => {
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

  const action = () =>
    document.querySelector<HTMLButtonElement>(".pane__dormant-action");

  it("shows when it was suspended, what resume will do, and fires onResume", () => {
    const onResume = vi.fn();
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "suspended", at } as const,
          stopped: true,
          resumeSessionId: "sess-abc",
          onResume,
        }),
      ),
    );

    expect(document.body.textContent).toContain("Suspended");
    expect(document.body.textContent).toContain("2h ago");
    expect(document.body.textContent).toContain("Resume session: sess-abc");
    // A suspended pane has no process — mounting a terminal would spawn one.
    expect(TerminalPane).not.toHaveBeenCalled();

    expect(action()!.textContent).toBe("Resume");
    act(() => action()!.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("names the session it will resume, in full on hover", () => {
    const id = "0198e2f3-4a1b-7c9d-8e2f-1a2b3c4d5e6f";
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "suspended", at: new Date().toISOString() } as const,
          stopped: true,
          resumeSessionId: id,
          onResume: vi.fn(),
        }),
      ),
    );

    const line = document.querySelector<HTMLElement>(".pane__idle-session")!;
    expect(line).not.toBeNull();
    expect(line.textContent).toBe(`Resume session: ${id}`);
    // A uuid outgrows a narrow tile, so the line ellipsizes and carries the
    // whole id as its tooltip.
    expect(line.title).toBe(id);
    expect(
      document.querySelector(".pane__idle-session-id")?.textContent,
    ).toBe(id);
  });

  it("shows the session id on a parked pane too — same promise, same evidence", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "parked" } as const,
          stopped: true,
          resumeSessionId: "sess-abc",
          onResume: vi.fn(),
        }),
      ),
    );
    expect(document.querySelector(".pane__idle-session")?.textContent).toBe(
      "Resume session: sess-abc",
    );
  });

  it("promises a FRESH session when the pane carries no binding", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "suspended", at: new Date().toISOString() } as const,
          stopped: true,
          resumeSessionId: null,
          onResume: vi.fn(),
        }),
      ),
    );

    expect(document.body.textContent).toContain("Starts a fresh session");
    expect(document.body.textContent).not.toContain("Resume session");
    expect(document.querySelector(".pane__idle-session")).toBeNull();
  });

  it("reads as never-started (not stale-dated) for a pane parked at launch", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "parked" } as const,
          stopped: true,
          onResume: vi.fn(),
        }),
      ),
    );

    // "Stopped" is the same word the launch setting uses for this state;
    // "Suspended" stays reserved for a pane the user stopped by hand.
    expect(document.body.textContent).toContain("Stopped");
    expect(document.body.textContent).not.toContain("Suspended");
    expect(document.body.textContent).not.toContain("ago");
    // Same verb as a suspended pane: one gesture, one word for it.
    expect(action()!.textContent).toBe("Resume");
  });

  it("keeps the transient restored tile free of a resume gesture", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "waking", origin: "restore" } as const,
          onResume: vi.fn(),
        }),
      ),
    );

    // The sweep is already waking it; a button would race that.
    expect(document.body.textContent).toContain("Waking up…");
    expect(action()).toBeNull();
  });

  it("a parked pane resumes from the same button as a suspended one", () => {
    // Same branch in production, so the asymmetry would only ever be in the
    // tests — and the launch policy makes this the FIRST card most users see.
    const onResume = vi.fn();
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "parked" } as const,
          stopped: true,
          resumeSessionId: "sess-abc",
          onResume,
        }),
      ),
    );

    expect(document.querySelector(".pane--idle")).not.toBeNull();
    act(() => action()!.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("dims exactly what the deck calls stopped", () => {
    // The rule itself lives in the deck now (one computation feeds this tile
    // AND the tray's marker); the pane's job is only to honour it.
    const mountIdle = (idle: PaneIdle, stopped: boolean) =>
      act(() =>
        root.render(createElement(AgentPane, { ...baseProps, idle, stopped })),
      );

    mountIdle({ reason: "suspended", at: new Date().toISOString() }, true);
    expect(document.querySelector(".pane--idle")).not.toBeNull();

    mountIdle({ reason: "waking", origin: "restore" }, false);
    expect(document.querySelector(".pane--idle")).toBeNull();
  });

  it("a gone folder still wins the card — that pane needs relocating, not resuming", () => {
    act(() =>
      root.render(
        createElement(AgentPane, {
          ...baseProps,
          idle: { reason: "suspended", at: new Date().toISOString() } as const,
          stopped: true,
          blockedDir: "/gone/worktree",
          onStartFresh: vi.fn(),
          onResume: vi.fn(),
        }),
      ),
    );

    expect(document.body.textContent).toContain("Folder is gone");
    expect(document.body.textContent).not.toContain("Suspended");
  });
});
