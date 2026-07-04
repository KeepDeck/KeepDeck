// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import type {
  AgentDialogResult,
  PathProbe,
} from "../../domain/agentLocation";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The dialog pulls the agent catalog via useAgents → IPC; pin one agent.
vi.mock("../../ipc/agents", () => ({
  listAgents: async () => [
    { id: "claude", label: "Claude Code", command: "claude", installed: true, path: null },
  ],
}));

/** Probe results: an attachable worktree, and a not-yet-existing dir (e.g. a
 * provisioning pane's target that git hasn't created yet). */
const WORKTREE: PathProbe = { exists: true, isWorktree: true, empty: false, branch: "kd/ws/2" };
const MISSING: PathProbe = { exists: false, isWorktree: false, empty: false, branch: null };

const pathInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Worktree path"]')!;
const branchInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]');
const createBtn = () =>
  document.querySelector<HTMLButtonElement>(".form__create")!;
const choiceBtn = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".form__choice")).find(
    (b) => b.textContent === label,
  );
const errorText = () => document.querySelector(".form__error")?.textContent;

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

describe("AgentDialog occupied-path flow", () => {
  let host: HTMLElement;
  let root: Root;
  let confirmed: AgentDialogResult[];

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    confirmed = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  /** Let the debounced probe fire and its promise land. */
  const settleProbe = async () =>
    act(async () => {
      vi.advanceTimersByTime(250);
    });

  /** Mount prefilled with an occupied path; `/base/kd-ws-2` and `-4` are held
   * by open panes, `-2` probes as a real worktree, everything else as new. */
  const mount = async (probeOf: Record<string, PathProbe> = { "/base/kd-ws-2": WORKTREE }) =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "/base/kd-ws-2",
          suggestedBranch: "kd/ws/2",
          probePath: async (p: string) => probeOf[p] ?? MISSING,
          isOccupied: (p: string) => p === "/base/kd-ws-2" || p === "/base/kd-ws-4",
          nextFreeLocation: async () => ({ path: "/base/kd-ws-3", branch: "kd/ws/3" }),
          pickFolder: async () => null,
          onConfirm: (r: AgentDialogResult) => confirmed.push(r),
          onCancel: () => {},
        }),
      ),
    );

  it("an occupied path blocks Create and offers the choices", async () => {
    await mount();
    // Occupancy is known synchronously — the warning shows even mid-probe,
    // but "Attach anyway" waits for the probe to confirm a real worktree.
    expect(errorText()).toBe("Already in use by another agent");
    expect(choiceBtn("Use next available")).toBeTruthy();
    expect(choiceBtn("Attach anyway")).toBeUndefined();
    await settleProbe();
    expect(choiceBtn("Attach anyway")).toBeTruthy();
    expect(createBtn().disabled).toBe(true);
  });

  it("Use next available swaps in the free path and its branch", async () => {
    await mount();
    await settleProbe();
    await act(async () => choiceBtn("Use next available")!.click());
    expect(pathInput().value).toBe("/base/kd-ws-3");
    await settleProbe(); // free path probes as new → branch field appears
    expect(branchInput()?.value).toBe("kd/ws/3");
    expect(createBtn().disabled).toBe(false);
    act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(confirmed).toEqual([
      {
        agentType: "claude",
        name: "",
        location: { kind: "new", path: "/base/kd-ws-3", branch: "kd/ws/3" },
      },
    ]);
  });

  it("Attach anyway unblocks Create as a plain attach to the worktree", async () => {
    await mount();
    await settleProbe();
    await act(async () => choiceBtn("Attach anyway")!.click());
    expect(errorText()).toBeUndefined();
    expect(createBtn().disabled).toBe(false);
    act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(confirmed[0]?.location).toEqual({
      kind: "existing",
      path: "/base/kd-ws-2",
      branch: "kd/ws/2",
    });
  });

  it("editing the path revokes an earlier Attach anyway", async () => {
    await mount({ "/base/kd-ws-2": WORKTREE, "/base/kd-ws-4": WORKTREE });
    await settleProbe();
    await act(async () => choiceBtn("Attach anyway")!.click());
    expect(createBtn().disabled).toBe(false);
    // Consent covered kd-ws-2; a different occupied path must block again.
    type(pathInput(), "/base/kd-ws-4");
    await settleProbe();
    expect(errorText()).toBe("Already in use by another agent");
    expect(createBtn().disabled).toBe(true);
  });

  it("a target that isn't a worktree yet (provisioning) offers no Attach anyway", async () => {
    await mount({ "/base/kd-ws-2": MISSING });
    await settleProbe();
    expect(choiceBtn("Use next available")).toBeTruthy();
    expect(choiceBtn("Attach anyway")).toBeUndefined();
    expect(createBtn().disabled).toBe(true);
  });
});
