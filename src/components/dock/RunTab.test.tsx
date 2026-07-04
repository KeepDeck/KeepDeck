// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSession } from "../../domain/runSessions";
import type { Workspace } from "../../domain/workspaces";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const manager = vi.hoisted(() => ({
  sessions: [] as RunSession[],
  launchRun: vi.fn(async () => "run-9"),
  stopRun: vi.fn(),
  restartRun: vi.fn(async () => {}),
  removeRun: vi.fn(),
  subscribeRuns: vi.fn(() => () => {}),
  getRunSessions: vi.fn(() => manager.sessions),
}));
vi.mock("../../app/runManager", () => manager);

// xterm can't mount under happy-dom; the log's contract is runManager's
// attach/replay, covered in runManager.test.ts.
vi.mock("./RunLog", () => ({ RunLog: () => null }));

import { RunTab } from "./RunTab";

const ws: Workspace = {
  id: "ws-1",
  name: "app",
  cwd: "/repo",
  worktreeBaseDir: "/wt",
  run: {
    presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
  },
  panes: [
    { id: "pane-1", cwd: "/wt/a", branch: "kd/a" },
    { id: "pane-2", cwd: "/wt/b", branch: "kd/b" },
  ],
};

function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RunTab", () => {
  let host: HTMLElement;
  let root: Root;
  let setRun: ReturnType<typeof vi.fn>;

  const mount = (overrides: Partial<Workspace> = {}, selectedPaneId = "pane-2") =>
    act(() =>
      root.render(
        createElement(RunTab, {
          ws: { ...ws, ...overrides },
          selectedPaneId,
          onSetRun: setRun,
        }),
      ),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    manager.sessions = [];
    setRun = vi.fn();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  it("defaults the target to the highlighted pane's worktree and runs a preset there", () => {
    mount();
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Run target directory"]',
    )!;
    expect(select.value).toBe("/wt/b");

    act(() =>
      document.querySelector<HTMLButtonElement>(".run__preset-run")!.click(),
    );
    expect(manager.launchRun).toHaveBeenCalledWith(
      "ws-1",
      { worktree: "/wt/b", branch: "kd/b" },
      { presetId: "run-1", command: "pnpm dev", name: "Dev" },
    );
  });

  it("falls back to the workspace folder without a highlighted worktree pane", () => {
    mount({}, "nope");
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Run target directory"]',
    )!;
    expect(select.value).toBe("/repo");
  });

  it("runs an ad-hoc command, and clears the draft after", () => {
    mount();
    const field = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Command to run"]',
    )!;
    type(field, "go run ./cmd");
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.textContent === "Run")!
        .click(),
    );
    expect(manager.launchRun).toHaveBeenCalledWith(
      "ws-1",
      { worktree: "/wt/b", branch: "kd/b" },
      { command: "go run ./cmd", name: "go run ./cmd" },
    );
    expect(field.value).toBe("");
  });

  it("save-as-preset saves through onSetRun and launches with the new preset id", () => {
    mount();
    type(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Command to run"]',
      )!,
      "pnpm worker",
    );
    act(() =>
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    type(
      document.querySelector<HTMLInputElement>('input[aria-label="Preset name"]')!,
      "Worker",
    );
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.textContent === "Run")!
        .click(),
    );

    expect(setRun).toHaveBeenCalledWith({
      presets: [
        { id: "run-1", name: "Dev", command: "pnpm dev" },
        { id: "run-2", name: "Worker", command: "pnpm worker" },
      ],
    });
    expect(manager.launchRun).toHaveBeenCalledWith(
      "ws-1",
      expect.anything(),
      { presetId: "run-2", command: "pnpm worker", name: "Worker" },
    );
  });

  it("deleting a preset edits the workspace, never launches", () => {
    mount();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Delete preset Dev"]')!
        .click(),
    );
    expect(setRun).toHaveBeenCalledWith({ presets: [] });
    expect(manager.launchRun).not.toHaveBeenCalled();
  });

  it("session rows: Stop while running, Restart after exit, ✕ removes", () => {
    manager.sessions = [
      {
        id: "run-1",
        wsId: "ws-1",
        name: "Dev",
        command: "pnpm dev",
        worktree: "/wt/a",
        port: 17_040,
        status: { kind: "running" },
      },
      {
        id: "run-2",
        wsId: "ws-1",
        name: "srv",
        command: "go run .",
        worktree: "/wt/b",
        status: { kind: "exited", code: 1 },
      },
      {
        id: "run-3",
        wsId: "OTHER",
        name: "foreign",
        command: "x",
        worktree: "/x",
        status: { kind: "running" },
      },
    ];
    mount();

    // Only this workspace's sessions show.
    expect(document.body.textContent).not.toContain("foreign");
    expect(document.body.textContent).toContain(":17040");
    expect(document.body.textContent).toContain("exit 1");

    const buttons = Array.from(document.querySelectorAll("button"));
    act(() => buttons.find((b) => b.textContent === "Stop")!.click());
    expect(manager.stopRun).toHaveBeenCalledWith("run-1");
    act(() => buttons.find((b) => b.textContent === "Restart")!.click());
    expect(manager.restartRun).toHaveBeenCalledWith("run-2");
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Remove run srv"]')!
        .click(),
    );
    expect(manager.removeRun).toHaveBeenCalledWith("run-2");
  });
});

describe("RunTab — target follows the highlighted pane", () => {
  let host: HTMLElement;
  let root: Root;
  let setRun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager.sessions = [];
    setRun = vi.fn();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const select = () =>
    document.querySelector<HTMLSelectElement>(
      'select[aria-label="Run target directory"]',
    )!;

  it("re-highlighting another worktree pane moves the target (the ▶ flow)", () => {
    const render = (selectedPaneId: string) =>
      act(() =>
        root.render(
          createElement(RunTab, { ws, selectedPaneId, onSetRun: setRun }),
        ),
      );
    render("pane-1");
    expect(select().value).toBe("/wt/a");
    render("pane-2");
    expect(select().value).toBe("/wt/b");
  });

  it("a manual pick survives re-renders that do NOT change the highlight", () => {
    const render = () =>
      act(() =>
        root.render(
          createElement(RunTab, { ws, selectedPaneId: "pane-1", onSetRun: setRun }),
        ),
      );
    render();
    const set = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!;
    act(() => {
      set.call(select(), ws.cwd);
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select().value).toBe("/repo");
    render(); // same highlight → the manual pick holds
    expect(select().value).toBe("/repo");
  });
});
