// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, WorkspaceSnapshot } from "@keepdeck/plugin-api";
import type { RunManager } from "../manager";
import type { RunPreset, RunSession } from "../domain";
import { setRuntime } from "../runtime";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// xterm can't mount under happy-dom; the log's contract is the manager's
// attach/replay, covered in manager.test.ts and RunLog.test.tsx.
vi.mock("./RunLog", () => ({ RunLog: () => null }));

import { RunTab } from "./RunTab";

const workspace: WorkspaceSnapshot = {
  id: "ws-1",
  name: "app",
  cwd: "/repo",
  panes: [
    { id: "pane-1", name: "a", cwd: "/wt/a", branch: "kd/a", agentType: "x" },
    { id: "pane-2", name: "b", cwd: "/wt/b", branch: "kd/b", agentType: "x" },
  ],
};

const PRESETS: RunPreset[] = [
  { id: "run-1", name: "Dev", command: "pnpm dev" },
  { id: "run-2", name: "Tests", command: "pnpm test" },
];

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

// A fresh fake manager per test — the tab reads it back through the runtime
// holder, so no module mock is needed.
function makeManager() {
  const manager = {
    sessions: [] as RunSession[],
    launchRun: vi.fn(async () => "rs-9"),
    stopRun: vi.fn(),
    restartRun: vi.fn(async () => {}),
    removeRun: vi.fn(),
    removeDeadRunsFor: vi.fn(),
    stopWorkspaceRuns: vi.fn(),
    stopAll: vi.fn(),
    attachRun: vi.fn(() => () => {}),
    resizeRun: vi.fn(),
    getSessions: vi.fn((): RunSession[] => manager.sessions),
    subscribe: vi.fn(() => () => {}),
  };
  return manager;
}

const kv = { get: vi.fn(), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
const ctx = {
  storage: { workspace: vi.fn(() => kv), global: kv },
  events: {
    onDeckChanged: vi.fn(() => ({ dispose: vi.fn() })),
    onWorkspaceClosed: vi.fn(() => ({ dispose: vi.fn() })),
    onPaneSelected: vi.fn(() => ({ dispose: vi.fn() })),
  },
} as unknown as PluginContext;

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
  let manager: ReturnType<typeof makeManager>;

  const mount = async (presets: RunPreset[], selectedPaneId = "pane-2") => {
    kv.get.mockResolvedValue(presets);
    await act(async () => {
      root.render(
        createElement(RunTab, { workspace, selectedPaneId }),
      );
    });
    // Flush the async storage read (usePresets hydrates on mount).
    await act(async () => {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = makeManager();
    setRuntime({ manager: manager as unknown as RunManager, ctx });
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    setRuntime(null);
  });

  it("every command gets a row; the idle glyph launches in the current target", async () => {
    await mount(PRESETS);
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

  it("a session in the CURRENT target fuses into its command's row", async () => {
    manager.sessions = [running()];
    await mount(PRESETS);

    // One row for Dev — no separate sessions list.
    expect(document.querySelectorAll(".run__cmd").length).toBe(2);
    expect(document.body.textContent).toContain(":17040");
    // The stop sits BESIDE the status dot, at rest — not behind hover.
    const live = document.querySelector(".run__g--live")!;
    expect(live.querySelector(".run__dot--running")).not.toBeNull();
    expect(live.contains(button("Stop: Dev"))).toBe(true);
    act(() => button("Stop: Dev")!.click());
    expect(manager.stopRun).toHaveBeenCalledWith("s1");
    // No idle Run action — the command already runs here.
    expect(button("Run: Dev")).toBeNull();
  });

  it("a stopping row shows only the status dot — no control until it lands", async () => {
    manager.sessions = [running({ status: { kind: "stopping" } })];
    await mount(PRESETS);
    expect(document.querySelector(".run__dot--stopping")).not.toBeNull();
    expect(button("Stop: Dev")).toBeNull();
    expect(button("Run: Dev")).toBeNull();
    // The caption's Stop is gone too — the kill is already in flight.
    expect(button("Stop Dev")).toBeNull();
  });

  it("an instance in ANOTHER target indents as a child row with its own controls", async () => {
    manager.sessions = [
      running({ worktree: "/wt/a", branch: "kd/a", status: { kind: "exited", code: 1 } }),
    ];
    await mount(PRESETS); // current target = /wt/b

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

  it("Run again relaunches with the preset's CURRENT command, not the snapshot", async () => {
    manager.sessions = [
      running({ command: "pnpm dev --old", status: { kind: "exited", code: 1 } }),
    ];
    await mount(PRESETS);
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

  it("the caption's ✕ hides the log; picking a row brings it back", async () => {
    manager.sessions = [running()];
    await mount(PRESETS);
    expect(document.querySelector(".run__logbox")).not.toBeNull();

    act(() => button("Hide the log")!.click());
    expect(document.querySelector(".run__logbox")).toBeNull();

    act(() => document.querySelector<HTMLElement>(".run__cmd")!.click());
    expect(document.querySelector(".run__logbox")).not.toBeNull();
  });

  it("an orphan session (its command was deleted) keeps a row with Remove only", async () => {
    manager.sessions = [running({ presetId: "run-9", name: "old dev" })];
    await mount(PRESETS);
    expect(document.body.textContent).toContain("old dev");
    expect(button("Edit preset old dev")).toBeNull();
    act(() => button("Remove run old dev")!.click());
    expect(manager.removeRun).toHaveBeenCalledWith("s1");
  });

  it("the log caption names whose output is shown", async () => {
    manager.sessions = [running()];
    await mount(PRESETS);
    const cap = document.querySelector(".run__logcap")!;
    expect(cap.textContent).toContain("Dev");
    expect(cap.textContent).toContain("kd/b");
    expect(cap.textContent).toContain(":17040");
  });

  it("the log caption offers Stop while the session runs — and only then", async () => {
    manager.sessions = [running()];
    await mount(PRESETS);
    const stop = button("Stop Dev")!;
    expect(document.querySelector(".run__logcap")!.contains(stop)).toBe(true);
    act(() => stop.click());
    expect(manager.stopRun).toHaveBeenCalledWith("s1");

    manager.sessions = [running({ status: { kind: "exited", code: 0 } })];
    await mount(PRESETS);
    expect(button("Stop Dev")).toBeNull();
    expect(button("Hide the log")).not.toBeNull();
  });

  it("the input toggle arms interactive input for a running session, and disarms on toggle-off", async () => {
    manager.sessions = [running()];
    await mount(PRESETS);

    // Read-only until armed — no lit border, toggle not pressed.
    const toggle = button("Enable input for Dev")!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".run__logbox--interactive")).toBeNull();

    act(() => toggle.click());
    expect(button("Disable input for Dev")).not.toBeNull();
    expect(button("Enable input for Dev")).toBeNull();
    expect(document.querySelector(".run__logbox--interactive")).not.toBeNull();

    act(() => button("Disable input for Dev")!.click());
    expect(button("Enable input for Dev")).not.toBeNull();
    expect(document.querySelector(".run__logbox--interactive")).toBeNull();
  });

  it("offers no input toggle for a session that is not running", async () => {
    manager.sessions = [running({ status: { kind: "exited", code: 0 } })];
    await mount(PRESETS);
    expect(button("Enable input for Dev")).toBeNull();
    // The log is still there, just read-only.
    expect(document.querySelector(".run__logbox")).not.toBeNull();
    expect(button("Hide the log")).not.toBeNull();
  });

  it("hiding the log disarms input — reopening the same run is read-only again", async () => {
    manager.sessions = [running()];
    await mount(PRESETS);
    act(() => button("Enable input for Dev")!.click());
    expect(document.querySelector(".run__logbox--interactive")).not.toBeNull();

    act(() => button("Hide the log")!.click());
    expect(document.querySelector(".run__logbox")).toBeNull();

    act(() => document.querySelector<HTMLElement>(".run__cmd")!.click());
    expect(document.querySelector(".run__logbox")).not.toBeNull();
    expect(button("Enable input for Dev")).not.toBeNull();
    expect(document.querySelector(".run__logbox--interactive")).toBeNull();
  });

  it("the header + opens the form ABOVE the list; Add saves without launching", async () => {
    await mount(PRESETS);
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
    expect(kv.set).toHaveBeenCalledWith("presets", [
      ...PRESETS,
      { id: "run-3", name: "pnpm worker", command: "pnpm worker" },
    ]);
    expect(manager.launchRun).not.toHaveBeenCalled();
    expect(document.querySelector(".run__form")).toBeNull();
  });

  it("✎ opens the form loaded; Save rewrites in place; ✕ deletes the command", async () => {
    await mount(PRESETS);
    act(() => button("Edit preset Dev")!.click());
    const field = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Command to run"]',
    )!;
    expect(field.value).toBe("pnpm dev");
    type(field, "pnpm install\npnpm tauri dev");
    act(() => byText("Save")!.click());
    expect(kv.set).toHaveBeenCalledWith("presets", [
      { id: "run-1", name: "Dev", command: "pnpm install\npnpm tauri dev" },
      PRESETS[1],
    ]);

    act(() => button("Delete preset Tests")!.click());
    // Dead sessions of the deleted command are swept — without this a
    // same-named orphan row made the delete look like it didn't work.
    expect(manager.removeDeadRunsFor).toHaveBeenCalledWith("ws-1", "run-2");
    expect(kv.set).toHaveBeenLastCalledWith(
      "presets",
      expect.not.arrayContaining([expect.objectContaining({ id: "run-2" })]),
    );
  });

  it("empty state invites the first command", async () => {
    await mount([]);
    expect(document.body.textContent).toContain("No run commands yet");
  });
});

describe("RunTab — target follows the highlighted pane", () => {
  let host: HTMLElement;
  let root: Root;
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = makeManager();
    setRuntime({ manager: manager as unknown as RunManager, ctx });
    kv.get.mockResolvedValue([]);
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    setRuntime(null);
  });

  const target = () =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Run target directory"]',
    )!;

  it("re-highlighting another worktree pane moves the target (the ▶ flow)", async () => {
    const render = async (selectedPaneId: string) => {
      await act(async () => {
        root.render(createElement(RunTab, { workspace, selectedPaneId }));
      });
      await act(async () => {});
    };
    await render("pane-1");
    expect(target().textContent).toBe("kd/a");
    await render("pane-2");
    expect(target().textContent).toBe("kd/b");
  });

  it("a manual pick survives re-renders that do NOT change the highlight", async () => {
    const render = async () => {
      await act(async () => {
        root.render(
          createElement(RunTab, { workspace, selectedPaneId: "pane-1" }),
        );
      });
      await act(async () => {});
    };
    await render();
    act(() => target().click());
    act(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      )
        .find((o) => o.textContent === "Workspace folder")!
        .click(),
    );
    expect(target().textContent).toBe("Workspace folder");
    await render(); // same highlight → the manual pick holds
    expect(target().textContent).toBe("Workspace folder");
  });
});
