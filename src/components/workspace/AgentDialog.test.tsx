// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import type {
  AgentDialogResult,
  Occupancy,
  PathProbe,
} from "../../domain/agents";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The dialog pulls the agent catalog via useAgents → IPC; pin one agent.
vi.mock("../../ipc/agents", () => ({
  listAgents: async () => [
    { id: "claude", label: "Claude Code", command: "claude", installed: true, path: null },
  ],
}));

/** Probe results: an attachable worktree, a not-yet-existing dir, and a
 * non-empty non-worktree dir (blocked). */
const WORKTREE: PathProbe = { exists: true, isWorktree: true, empty: false, branch: "kd/ws/2" };
const MISSING: PathProbe = { exists: false, isWorktree: false, empty: false, branch: null };
const BLOCKED: PathProbe = { exists: true, isWorktree: false, empty: false, branch: null };

const pathInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Worktree path"]')!;
const branchInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]');
const createBtn = () =>
  document.querySelector<HTMLButtonElement>(".form__create")!;
/** The inline occupied-path actions are icon-only — find them by their label. */
const choiceBtn = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `.form__choice[aria-label="${label}"]`,
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

const submit = () =>
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

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

  /** Mount prefilled with `/base/kd-ws-2`, held by an open pane running in a
   * live worktree unless overridden; other paths probe as new/missing. */
  const mount = async (
    opts: {
      probeOf?: Record<string, PathProbe>;
      occupancyOf?: Record<string, Occupancy>;
    } = {},
  ) => {
    const probeOf = opts.probeOf ?? { "/base/kd-ws-2": WORKTREE };
    const occupancyOf = opts.occupancyOf ?? { "/base/kd-ws-2": "worktree" as const };
    return act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "/base/kd-ws-2",
          suggestedBranch: "kd/ws/2",
          probePath: async (p: string) => probeOf[p] ?? MISSING,
          occupancyAt: (p: string) => occupancyOf[p] ?? null,
          nextFreeLocation: async () => ({ path: "/base/kd-ws-3", branch: "kd/ws/3" }),
          pickFolder: async () => null,
          onConfirm: (r: AgentDialogResult) => confirmed.push(r),
          onCancel: () => {},
        }),
      ),
    );
  };

  it("an occupied path blocks Create and offers both choices at once — no probe wait", async () => {
    await mount();
    // Occupancy is known synchronously, and worktree occupancy itself proves
    // there is a worktree to attach to: both actions render immediately.
    expect(errorText()).toBe("Already in use by another agent");
    expect(choiceBtn("Use next available")).toBeTruthy();
    expect(choiceBtn("Attach anyway")).toBeTruthy();
    expect(createBtn().disabled).toBe(true);
  });

  it("Use next available swaps in the free path and its branch", async () => {
    await mount();
    await act(async () => choiceBtn("Use next available")!.click());
    expect(pathInput().value).toBe("/base/kd-ws-3");
    await settleProbe(); // free path probes as new → branch field appears
    expect(branchInput()?.value).toBe("kd/ws/3");
    expect(createBtn().disabled).toBe(false);
    submit();
    expect(confirmed).toEqual([
      {
        agentType: "claude",
        name: "",
        location: { kind: "new", path: "/base/kd-ws-3", branch: "kd/ws/3" },
      },
    ]);
  });

  it("Attach anyway unblocks Create instantly; the probe then fills the branch", async () => {
    await mount();
    await act(async () => choiceBtn("Attach anyway")!.click());
    expect(errorText()).toBeUndefined();
    expect(createBtn().disabled).toBe(false); // before the probe lands
    await settleProbe();
    submit();
    expect(confirmed[0]?.location).toEqual({
      kind: "existing",
      path: "/base/kd-ws-2",
      branch: "kd/ws/2",
    });
  });

  it("editing the path revokes an earlier Attach anyway", async () => {
    await mount({
      probeOf: { "/base/kd-ws-2": WORKTREE, "/base/kd-ws-4": WORKTREE },
      occupancyOf: { "/base/kd-ws-2": "worktree", "/base/kd-ws-4": "worktree" },
    });
    await act(async () => choiceBtn("Attach anyway")!.click());
    expect(createBtn().disabled).toBe(false);
    // Consent covered kd-ws-2; a different occupied path must block again.
    type(pathInput(), "/base/kd-ws-4");
    expect(errorText()).toBe("Already in use by another agent");
    expect(createBtn().disabled).toBe(true);
  });

  it("a blocked path offers Use next available — an error, but not a dead end", async () => {
    // The prefilled dir has files and isn't a worktree (e.g. a leftover
    // folder): no pane holds it, so the state comes from the probe.
    await mount({
      probeOf: { "/base/kd-ws-2": BLOCKED },
      occupancyOf: {},
    });
    await settleProbe();
    expect(errorText()).toBe(
      "Folder has files and isn't a worktree — pick a new or empty folder",
    );
    expect(choiceBtn("Use next available")).toBeTruthy();
    expect(choiceBtn("Attach anyway")).toBeNull(); // nothing to attach to
    expect(createBtn().disabled).toBe(true);
    await act(async () => choiceBtn("Use next available")!.click());
    expect(pathInput().value).toBe("/base/kd-ws-3");
    await settleProbe(); // free path probes as new → branch field appears
    expect(branchInput()?.value).toBe("kd/ws/3");
    expect(createBtn().disabled).toBe(false);
  });

  it("a provisioning target offers no Attach anyway — nothing exists to attach to", async () => {
    await mount({
      probeOf: {},
      occupancyOf: { "/base/kd-ws-2": "provisioning" },
    });
    await settleProbe();
    expect(choiceBtn("Use next available")).toBeTruthy();
    expect(choiceBtn("Attach anyway")).toBeNull();
    expect(createBtn().disabled).toBe(true);
  });
});
