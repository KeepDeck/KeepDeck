// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForkTargetDialog } from "./ForkTargetDialog";
import type { AgentInfo, Occupancy, PathProbe } from "../../domain/agents";
import type { SessionHandle } from "../../domain/journal";
import type { ForkTarget, ForkTargetDialogResult } from "../../app/useJournalFork";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Probe results: a not-yet-existing dir (new worktree), an attachable
 * worktree, and a non-empty non-worktree dir (blocked). */
const MISSING: PathProbe = { exists: false, isWorktree: false, empty: false, branch: null };
const WORKTREE: PathProbe = { exists: true, isWorktree: true, empty: false, branch: "kd/ws/2" };
const BLOCKED: PathProbe = { exists: true, isWorktree: false, empty: false, branch: null };

const RECORD: SessionHandle = {
  agent: "codex",
  sessionId: "s-1",
  cwd: "/ws",
  title: "iOS-personal-area",
};
const AGENTS = [
  { id: "codex", label: "Codex" },
] as unknown as AgentInfo[];
const WS_CWD = "/Users/x/XcodeProjects/iOS-personal-area";

const pathInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Fork path"]')!;
const branchInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]');
const forkBtn = () =>
  document.querySelector<HTMLButtonElement>(".form__create")!;
const fieldBtn = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `.form__field-btn[aria-label="${label}"]`,
  );

/** Type into a controlled React input: set via the native setter (bypassing
 * React's value tracker) and fire a bubbling `input` event. */
function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

const submit = () =>
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("ForkTargetDialog", () => {
  let host: HTMLElement;
  let root: Root;
  let confirmed: ForkTarget[];
  let probeResult: PathProbe;
  let occupied: Occupancy;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    confirmed = [];
    probeResult = MISSING;
    occupied = null;
    act(() => {
      root.render(
        createElement(ForkTargetDialog, {
          record: RECORD,
          agents: AGENTS,
          workspaceCwd: WS_CWD,
          defaultYolo: false,
          probe: (path: string) => {
            void path;
            return Promise.resolve(probeResult);
          },
          occupancy: () => occupied,
          pickFolder: () => Promise.resolve(null),
          onConfirm: ({ target }) => confirmed.push(target),
          onCancel: () => {},
        }),
      );
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  /** Let the debounced path probe fire and its promise land. */
  const settleProbe = async () =>
    act(async () => {
      vi.advanceTimersByTime(250);
    });

  it("lays the path row out in the field anatomy (input grows, button aligns)", () => {
    const field = document.querySelector(".form__path > .form__field.form__path-field");
    expect(field).not.toBeNull();
    const input = field!.querySelector("input")!;
    expect(input.className).toContain("form__field-input");
    expect(input.placeholder).toBe("Empty = the workspace folder");
    // The Choose… button is the field's row sibling, not inside it.
    expect(field!.parentElement!.querySelector(":scope > .form__dir-btn")).not.toBeNull();
  });

  it("renders the lede as a neutral description, not a status hint", () => {
    const desc = document.querySelector(".form__desc");
    expect(desc?.textContent).toContain("a new Codex conversation");
    // The lede is the paragraph right after the title — not a status hint.
    expect(document.querySelector(".form__title + p")!.className).toBe("form__desc");
  });

  it("anchors the clear button inside the field and clears the path", async () => {
    type(pathInput(), "/tmp/fork-area");
    await settleProbe();
    const clear = fieldBtn("Clear path")!;
    expect(clear.closest(".form__field")).toBe(pathInput().parentElement);
    click(clear);
    expect(pathInput().value).toBe("");
    expect(fieldBtn("Clear path")).toBeNull();
  });

  it("suggests the branch from the path's folder name and follows while untouched", async () => {
    type(pathInput(), "/tmp/fork-area");
    await settleProbe();
    expect(branchInput()!.value).toBe("fork-area");

    type(pathInput(), "/tmp/other-place");
    await settleProbe();
    expect(branchInput()!.value).toBe("other-place");
  });

  it("keeps a user-edited branch when the path moves; ↺ re-attaches it", async () => {
    type(pathInput(), "/tmp/fork-area");
    await settleProbe();
    type(branchInput()!, "custom-branch");

    type(pathInput(), "/tmp/other-place");
    await settleProbe();
    expect(branchInput()!.value).toBe("custom-branch");

    click(fieldBtn("Reset to the suggested branch")!);
    expect(branchInput()!.value).toBe("other-place");
  });

  it("forks into the workspace folder on an empty path", () => {
    expect(forkBtn().disabled).toBe(false);
    submit();
    expect(confirmed).toEqual([{ kind: "dir", cwd: WS_CWD }]);
  });

  it("forks into a new worktree with the suggested branch", async () => {
    type(pathInput(), "/tmp/fork-area");
    await settleProbe();
    expect(forkBtn().disabled).toBe(false);
    submit();
    expect(confirmed).toEqual([
      { kind: "worktree", path: "/tmp/fork-area", branch: "fork-area" },
    ]);
  });

  it("attaches to an existing worktree without asking for a branch", async () => {
    probeResult = WORKTREE;
    type(pathInput(), "/tmp/live-wt");
    await settleProbe();
    expect(branchInput()).toBeNull();
    submit();
    expect(confirmed).toEqual([{ kind: "dir", cwd: "/tmp/live-wt" }]);
  });

  it("disables Fork for blocked and occupied paths", async () => {
    probeResult = BLOCKED;
    type(pathInput(), "/tmp/taken-dir");
    await settleProbe();
    expect(forkBtn().disabled).toBe(true);

    occupied = "worktree";
    probeResult = WORKTREE;
    type(pathInput(), "/tmp/held-wt");
    await settleProbe();
    expect(forkBtn().disabled).toBe(true);
    submit();
    expect(confirmed).toEqual([]);
  });
});

describe("ForkTargetDialog YOLO toggle", () => {
  let host: HTMLElement;
  let root: Root;
  let confirmed: ForkTargetDialogResult[];

  // codex is the forked agent; flipping supportsYolo hides/shows the toggle.
  let agents: AgentInfo[];

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    confirmed = [];
    agents = [{ id: "codex", label: "Codex", supportsYolo: true }] as unknown as AgentInfo[];
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const mount = (defaultYolo: boolean) =>
    act(() =>
      root.render(
        createElement(ForkTargetDialog, {
          record: RECORD,
          agents,
          workspaceCwd: WS_CWD,
          defaultYolo,
          // An empty path is valid (the workspace folder) — enough to submit.
          probe: () => Promise.resolve(MISSING),
          occupancy: () => null,
          pickFolder: () => Promise.resolve(null),
          onConfirm: ({ target, yolo }) => confirmed.push({ target, yolo }),
          onCancel: () => {},
        }),
      ),
    );

  const yoloCheckbox = () =>
    document.querySelector<HTMLInputElement>(".form__yolo input");

  it("renders — prefilled from the global default — when the agent supports it", () => {
    mount(true);
    expect(yoloCheckbox()).not.toBeNull();
    expect(yoloCheckbox()!.checked).toBe(true);
  });

  it("is hidden for an agent whose plugin declares no YOLO support", () => {
    agents = [{ id: "codex", label: "Codex", supportsYolo: false }] as unknown as AgentInfo[];
    mount(true);
    expect(yoloCheckbox()).toBeNull();
  });

  it("rides the resolved choice onto onConfirm, gated by capability", () => {
    mount(false);
    expect(yoloCheckbox()!.checked).toBe(false);

    // Off → yolo false (the workspace-folder target is valid on an empty path).
    submit();
    expect(confirmed).toEqual([
      { target: { kind: "dir", cwd: WS_CWD }, yolo: false },
    ]);

    // Flip on → yolo true reaches the caller.
    click(yoloCheckbox()!);
    submit();
    expect(confirmed[1]).toEqual({
      target: { kind: "dir", cwd: WS_CWD },
      yolo: true,
    });
  });

  it("never submits YOLO when the agent lacks support, even if the default was on", () => {
    agents = [{ id: "codex", label: "Codex", supportsYolo: false }] as unknown as AgentInfo[];
    mount(true);
    submit();
    // No toggle was shown, so onConfirm's yolo is forced false regardless of
    // the prefilled default.
    expect(confirmed[0].yolo).toBe(false);
  });

  it("rides the YOLO choice onto onConfirm for a worktree target too", async () => {
    mount(true);
    type(pathInput(), "/tmp/fork-area");
    // Settle the debounced path probe (200ms) so the path resolves to a
    // new-worktree target with the folder-name branch suggestion.
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(branchInput()!.value).toBe("fork-area");
    expect(yoloCheckbox()!.checked).toBe(true); // prefilled from defaultYolo

    submit();
    expect(confirmed[0]).toEqual({
      target: { kind: "worktree", path: "/tmp/fork-area", branch: "fork-area" },
      yolo: true,
    });
  });
});
