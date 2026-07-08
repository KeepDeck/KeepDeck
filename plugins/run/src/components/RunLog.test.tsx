// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import type { RunManager } from "../manager";
import { setRuntime } from "../runtime";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// xterm can't mount under happy-dom — stub the renderer surface. The log's
// output contract is the manager's attach/replay, covered in manager.test.ts;
// here only the wiring around the terminal is under test.
interface FakeTerm {
  options: Record<string, unknown>;
  focus: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
}
const xterm = vi.hoisted(() => ({ instances: [] as FakeTerm[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    // Capture the onData listener so a test can drive a keystroke through it.
    private dataCb: ((data: string) => void) | null = null;
    onData = vi.fn((cb: (data: string) => void) => {
      this.dataCb = cb;
      return { dispose: vi.fn() };
    });
    emitData(data: string) {
      this.dataCb?.(data);
    }
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      xterm.instances.push(this as unknown as FakeTerm);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

// The linker's own behavior is covered in @keepdeck/terminal-kit's own suite;
// the log only has to hand it the terminal and the run's worktree. Mock ONLY
// the linker, keeping PaneHintView/useTransient real.
const linker = vi.hoisted(() => ({
  registerTerminalLinks: vi.fn(
    (_term: object, _host: HTMLElement, _target: { cwd: string | null }) => ({
      dispose: vi.fn(),
    }),
  ),
}));
vi.mock("@keepdeck/terminal-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@keepdeck/terminal-kit")>();
  return { ...actual, registerTerminalLinks: linker.registerTerminalLinks };
});

import { RunLog } from "./RunLog";

function makeManager() {
  return {
    attachRun: vi.fn(() => vi.fn()),
    resizeRun: vi.fn(),
    writeRun: vi.fn(),
  } as unknown as RunManager;
}

const ctx = {
  host: { settings: vi.fn(async () => ({ terminalScrollback: 1000 })) },
  services: { opener: { openUrl: vi.fn(), openPath: vi.fn() } },
} as unknown as PluginContext;

describe("RunLog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let manager: RunManager;

  const mount = async (sessionId: string, cwd: string, interactive = false) => {
    await act(async () => {
      root.render(createElement(RunLog, { sessionId, cwd, interactive }));
    });
    // Flush the awaited host.settings() before the Terminal constructs.
    await act(async () => {});
  };

  const rerender = async (
    sessionId: string,
    cwd: string,
    interactive: boolean,
  ) => {
    await act(async () => {
      root.render(createElement(RunLog, { sessionId, cwd, interactive }));
    });
  };

  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    manager = makeManager();
    setRuntime({ manager, ctx });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setRuntime(null);
    vi.clearAllMocks();
    xterm.instances.length = 0;
  });

  it("registers the shared linker on its terminal, resolving against the run's worktree", async () => {
    await mount("s1", "/wt/b");

    expect(linker.registerTerminalLinks).toHaveBeenCalledTimes(1);
    const [term, , target] = linker.registerTerminalLinks.mock.calls[0];
    expect(term).toBe(xterm.instances[0]);
    expect(target.cwd).toBe("/wt/b");
  });

  it("disposes the linker with the log", async () => {
    await mount("s1", "/wt/b");
    const registration = linker.registerTerminalLinks.mock.results[0].value as {
      dispose: ReturnType<typeof vi.fn>;
    };

    act(() => root.unmount());
    expect(registration.dispose).toHaveBeenCalled();
  });

  it("is read-only by default — stdin off and no keystroke forwarded", async () => {
    await mount("s1", "/wt/b");
    const term = xterm.instances[0];
    expect(term.options.disableStdin).toBe(true);

    act(() => term.emitData("y"));
    expect(manager.writeRun).not.toHaveBeenCalled();
  });

  it("forwards keystrokes to the PTY when armed for input", async () => {
    await mount("s1", "/wt/b", true);
    const term = xterm.instances[0];
    expect(term.options.disableStdin).toBe(false);
    expect(term.focus).toHaveBeenCalled();

    act(() => term.emitData("y\r"));
    expect(manager.writeRun).toHaveBeenCalledWith("s1", "y\r");
  });

  it("arms and disarms the LIVE terminal without rebuilding it", async () => {
    await mount("s1", "/wt/b", false);
    const term = xterm.instances[0];
    expect(term.options.disableStdin).toBe(true);

    await rerender("s1", "/wt/b", true);
    // Same terminal instance — no rebuild (would drop scrollback).
    expect(xterm.instances).toHaveLength(1);
    expect(term.options.disableStdin).toBe(false);
    expect(term.focus).toHaveBeenCalled();
    act(() => term.emitData("n"));
    expect(manager.writeRun).toHaveBeenCalledWith("s1", "n");

    await rerender("s1", "/wt/b", false);
    expect(term.options.disableStdin).toBe(true);
    manager.writeRun = vi.fn();
    act(() => term.emitData("x"));
    expect(manager.writeRun).not.toHaveBeenCalled();
  });
});
