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
  } as unknown as RunManager;
}

const ctx = {
  host: { settings: vi.fn(async () => ({ terminalScrollback: 1000 })) },
  services: { opener: { openUrl: vi.fn(), openPath: vi.fn() } },
} as unknown as PluginContext;

describe("RunLog", () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = async (sessionId: string, cwd: string) => {
    await act(async () => {
      root.render(createElement(RunLog, { sessionId, cwd }));
    });
    // Flush the awaited host.settings() before the Terminal constructs.
    await act(async () => {});
  };

  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    setRuntime({ manager: makeManager(), ctx });
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
});
