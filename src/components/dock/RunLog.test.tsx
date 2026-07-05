// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const manager = vi.hoisted(() => ({
  attachRun: vi.fn(() => vi.fn()),
  resizeRun: vi.fn(),
}));
vi.mock("../../app/runManager", () => manager);

vi.mock("../../app/useSettings", () => ({ useSettings: () => null }));

// xterm can't mount under happy-dom — stub the renderer surface. The log's
// output contract is runManager's attach/replay, covered in runManager.test.ts;
// here only the wiring around the terminal is under test.
const xterm = vi.hoisted(() => ({ instances: [] as object[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    constructor() {
      xterm.instances.push(this);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

// The linker's own behavior is covered in terminalLinks.test.ts; the log only
// has to hand it the terminal and the run's worktree.
const linker = vi.hoisted(() => ({
  registerTerminalLinks: vi.fn(
    (_term: object, _host: HTMLElement, _target: { cwd: string | null }) => ({
      dispose: vi.fn(),
    }),
  ),
}));
vi.mock("../terminal/terminalLinks", () => linker);

import { RunLog } from "./RunLog";

describe("RunLog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
    xterm.instances.length = 0;
  });

  it("registers the shared linker on its terminal, resolving against the run's worktree", () => {
    act(() => {
      root.render(createElement(RunLog, { sessionId: "s1", cwd: "/wt/b" }));
    });

    expect(linker.registerTerminalLinks).toHaveBeenCalledTimes(1);
    const [term, , target] = linker.registerTerminalLinks.mock.calls[0];
    expect(term).toBe(xterm.instances[0]);
    expect(target.cwd).toBe("/wt/b");
  });

  it("disposes the linker with the log", () => {
    act(() => {
      root.render(createElement(RunLog, { sessionId: "s1", cwd: "/wt/b" }));
    });
    const registration = linker.registerTerminalLinks.mock.results[0]
      .value as { dispose: ReturnType<typeof vi.fn> };

    act(() => root.unmount());
    expect(registration.dispose).toHaveBeenCalled();
  });
});
