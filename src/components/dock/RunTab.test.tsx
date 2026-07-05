// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSession } from "../../domain/run";
import type { Workspace } from "../../domain/deck";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const manager = vi.hoisted(() => ({
  sessions: [] as RunSession[],
  launchRun: vi.fn(async () => "run-9"),
  stopRun: vi.fn(),
  restartRun: vi.fn(async () => {}),
  removeRun: vi.fn(),
  removeDeadRunsFor: vi.fn(),
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
    presets: [
      { id: "run-1", name: "Dev", command: "pnpm dev" },
      { id: "run-2", name: "Tests", command: "pnpm test" },
    ],
  },
  panes: [
    { id: "pane-1", cwd: "/wt/a", branch: "kd/a" },
    { id: "pane-2", cwd: "/wt/b", branch: "kd/b" },
  ],
};

const running = (over: Partial<RunSession> = {}): RunSession => ({
  id: "s1",
  wsId: "ws-1",
  name: "Dev",
  presetId: "run-1",
  command: "pnpm dev",
  worktree: "/wt/b",
  branch: "kd/b",
  port: 17_040,
  status: { kind: "running" },
  ...over,
});

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

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );

describe("RunTab — the merged Commands list", () => {
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

  it("every command gets a row; the idle glyph launches in the current target", () => {
    mount();
    const names = [...document.querySelectorAll(".run__cmd-name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Dev", "Tests"]);

    act(() => button("Run: Dev")!.click());
    expect(manager.launchRun).toHaveBeenCalledWith(
      "ws-1",
      { worktree: "/wt/b", branch: "kd/b" },
      { presetId: "run-1", command: "pnpm dev", name: "Dev" },
    );
  });

  it("a session in the CURRENT target fuses into its command's row", () => {
    manager.sessions = [running()];
    mount();

    // One row for Dev — no separate sessions list.
    expect(document.querySelectorAll(".run__cmd").length).toBe(2);
    expect(document.body.textContent).toContain(":17040");
    // The glyph's hover face stops it.
    act(() => button("Stop: Dev")!.click());
    expect(manager.stopRun).toHaveBeenCalledWith("s1");
    // No idle Run action — the command already runs here.
    expect(button("Run: Dev")).toBeNull();
  });

  it("an instance in ANOTHER target indents as a child row with its own controls", () => {
    manager.sessions = [
      running({ worktree: "/wt/a", branch: "kd/a", status: { kind: "exited", code: 1 } }),
    ];
    mount(); // current target = /wt/b

    const child = document.querySelector(".run__cmd--child")!;
    expect(child.textContent).toContain("kd/a");
    expect(child.textContent).toContain("exit 1");
    // The parent row still offers launching HERE.
    expect(button("Run: Dev")).not.toBeNull();
    // The child's glyph re-runs in ITS target — with the preset's CURRENT
    // command (the manager replaces the dead session for that target).
    act(() => button("Run again: Dev (kd/a)")!.click());
    expect(manager.launchRun).toHaveBeenCalledWith(
      "ws-1",
      { worktree: "/wt/a", branch: "kd/a" },
      { presetId: "run-1", command: "pnpm dev", name: "Dev" },
    );
    expect(manager.restartRun).not.toHaveBeenCalled();
    act(() => button("Remove run Dev in kd/a")!.click());
    expect(manager.removeRun).toHaveBeenCalledWith("s1");
  });

  it("Run again relaunches with the preset's CURRENT command, not the snapshot", () => {
    manager.sessions = [
      running({ command: "pnpm dev --old", status: { kind: "exited", code: 1 } }),
    ];
    mount();
    expect(document.body.textContent).toContain("exit 1");
    act(() => button("Run again: Dev")!.click());
    // The edited preset command wins over the dead session's snapshot.
    expect(manager.launchRun).toHaveBeenCalledWith(
      "ws-1",
      { worktree: "/wt/b", branch: "kd/b" },
      { presetId: "run-1", command: "pnpm dev", name: "Dev" },
    );
    expect(manager.restartRun).not.toHaveBeenCalled();
  });

  it("the caption's ✕ hides the log; picking a row brings it back", () => {
    manager.sessions = [running()];
    mount();
    expect(document.querySelector(".run__logbox")).not.toBeNull();

    act(() => button("Hide the log")!.click());
    expect(document.querySelector(".run__logbox")).toBeNull();

    act(() =>
      document.querySelector<HTMLElement>(".run__cmd")!.click(),
    );
    expect(document.querySelector(".run__logbox")).not.toBeNull();
  });

  it("an orphan session (its command was deleted) keeps a row with Remove only", () => {
    manager.sessions = [running({ presetId: "run-9", name: "old dev" })];
    mount();
    expect(document.body.textContent).toContain("old dev");
    expect(button("Edit preset old dev")).toBeNull();
    act(() => button("Remove run old dev")!.click());
    expect(manager.removeRun).toHaveBeenCalledWith("s1");
  });

  it("the log caption names whose output is shown", () => {
    manager.sessions = [running()];
    mount();
    const cap = document.querySelector(".run__logcap")!;
    expect(cap.textContent).toContain("Dev");
    expect(cap.textContent).toContain("kd/b");
    expect(cap.textContent).toContain(":17040");
  });

  it("the header + opens the form ABOVE the list; Add saves without launching", () => {
    mount();
    expect(document.querySelector(".run__form")).toBeNull();

    act(() => button("Add command")!.click());
    const form = document.querySelector(".run__form")!;
    const list = document.querySelector(".run__cmds")!;
    expect(
      form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    type(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Command to run"]',
      )!,
      "pnpm worker",
    );
    act(() => byText("Add")!.click());
    expect(setRun).toHaveBeenCalledWith({
      presets: [
        ...ws.run!.presets,
        { id: "run-3", name: "pnpm worker", command: "pnpm worker" },
      ],
    });
    expect(manager.launchRun).not.toHaveBeenCalled();
    expect(document.querySelector(".run__form")).toBeNull();
  });

  it("✎ opens the form loaded; Save rewrites in place; ✕ deletes the command", () => {
    mount();
    act(() => button("Edit preset Dev")!.click());
    const field = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Command to run"]',
    )!;
    expect(field.value).toBe("pnpm dev");
    type(field, "pnpm install\npnpm tauri dev");
    act(() => byText("Save")!.click());
    expect(setRun).toHaveBeenCalledWith({
      presets: [
        { id: "run-1", name: "Dev", command: "pnpm install\npnpm tauri dev" },
        ws.run!.presets[1],
      ],
    });

    act(() => button("Delete preset Tests")!.click());
    // Dead sessions of the deleted command are swept — without this a
    // same-named orphan row made the delete look like it didn't work.
    expect(manager.removeDeadRunsFor).toHaveBeenCalledWith("ws-1", "run-2");
    expect(setRun).toHaveBeenLastCalledWith({
      presets: expect.not.arrayContaining([
        expect.objectContaining({ id: "run-2" }),
      ]) as unknown as Workspace["run"],
    });
  });

  it("empty state invites the first command", () => {
    mount({ run: undefined });
    expect(document.body.textContent).toContain("No run commands yet");
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

  const target = () =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Run target directory"]',
    )!;

  it("re-highlighting another worktree pane moves the target (the ▶ flow)", () => {
    const render = (selectedPaneId: string) =>
      act(() =>
        root.render(
          createElement(RunTab, { ws, selectedPaneId, onSetRun: setRun }),
        ),
      );
    render("pane-1");
    expect(target().textContent).toBe("kd/a");
    render("pane-2");
    expect(target().textContent).toBe("kd/b");
  });

  it("a manual pick survives re-renders that do NOT change the highlight", () => {
    const render = () =>
      act(() =>
        root.render(
          createElement(RunTab, { ws, selectedPaneId: "pane-1", onSetRun: setRun }),
        ),
      );
    render();
    act(() => target().click());
    act(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      )
        .find((o) => o.textContent === "Workspace folder")!
        .click(),
    );
    expect(target().textContent).toBe("Workspace folder");
    render(); // same highlight → the manual pick holds
    expect(target().textContent).toBe("Workspace folder");
  });
});
