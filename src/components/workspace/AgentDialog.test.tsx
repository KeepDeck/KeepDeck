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

// The dialog pulls the agent catalog via useAgents; pin one agent at the
// hook seam (the real hook would bootstrap the real plugin system).
vi.mock("../../app/useAgents", () => ({
  useAgents: () => ({
    agents: [
      {
        id: "claude",
        label: "Claude Code",
        icon: { viewBox: "0 0 24 24", path: "M0 0h24v24H0z", color: "#D97757" },
        command: "claude",
        installed: true,
        path: null,
      },
    ],
    loading: false,
  }),
  resetAgentsCache: () => {},
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

describe("AgentDialog worktree location flow", () => {
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
   * live worktree unless overridden; other paths probe as new/missing. The
   * base-branch options default to a small local list; `branches: null`
   * simulates an unavailable listing (the IPC rejected). */
  const mount = async (
    opts: {
      probeOf?: Record<string, PathProbe>;
      occupancyOf?: Record<string, Occupancy>;
      branches?: string[] | null;
    } = {},
  ) => {
    const probeOf = opts.probeOf ?? { "/base/kd-ws-2": WORKTREE };
    const occupancyOf = opts.occupancyOf ?? { "/base/kd-ws-2": "worktree" as const };
    const branches = opts.branches === undefined ? ["develop", "main"] : opts.branches;
    return act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "/base/kd-ws-2",
          suggestedBranch: "kd/ws/2",
          probePath: async (p: string) => probeOf[p] ?? MISSING,
          listBranches: async () => {
            if (branches === null) throw new Error("git unavailable");
            return branches;
          },
          // The real derivation lives in useAgentDialog (tested there); this
          // fake mirrors its contract: canonical kd-ws-<n> folders map to
          // kd/ws/<n>, anything else implies its own folder name.
          branchForPath: async (p: string) => {
            const folder = p.slice(p.lastIndexOf("/") + 1);
            const m = /^kd-ws-(\d+)$/.exec(folder);
            return m ? `kd/ws/${m[1]}` : folder || null;
          },
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
        location: {
          kind: "new",
          path: "/base/kd-ws-3",
          branch: "kd/ws/3",
          // The untouched base field carries the prefilled current branch.
          baseBranch: "main",
        },
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

  it("the branch follows the path's folder name while untouched", async () => {
    await mount({ probeOf: {}, occupancyOf: {} }); // prefill probes as new
    await settleProbe();
    expect(branchInput()?.value).toBe("kd/ws/2");
    type(pathInput(), "/base/kd-ws-7");
    await settleProbe();
    expect(branchInput()?.value).toBe("kd/ws/7");
    // A hand-named folder implies its own name as the branch.
    type(pathInput(), "/base/fix-login");
    await settleProbe();
    expect(branchInput()?.value).toBe("fix-login");
  });

  it("an edited branch stays the user's; reset re-attaches it to the path", async () => {
    await mount({ probeOf: {}, occupancyOf: {} });
    await settleProbe();
    type(branchInput()!, "my/branch");
    type(pathInput(), "/base/kd-ws-5");
    await settleProbe();
    expect(branchInput()?.value).toBe("my/branch"); // the edit wins
    // ↺ resets to the branch the CURRENT path implies, not the open-time one…
    const reset = document.querySelector<HTMLButtonElement>(
      '[aria-label="Reset to the suggested branch"]',
    )!;
    await act(async () => reset.click());
    expect(branchInput()?.value).toBe("kd/ws/5");
    // …and the branch follows the path again from here on.
    type(pathInput(), "/base/kd-ws-6");
    await settleProbe();
    expect(branchInput()?.value).toBe("kd/ws/6");
  });

  const baseInput = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Base branch"]');

  it("the base-branch picker exists only where a branch is CREATED", async () => {
    // Attaching to an existing worktree forks nothing — no base to pick.
    await mount({ probeOf: { "/base/kd-ws-2": WORKTREE }, occupancyOf: {} });
    await settleProbe();
    expect(baseInput()).toBeNull();
    // A free path creates a branch — the picker appears.
    type(pathInput(), "/base/kd-ws-9");
    await settleProbe();
    expect(baseInput()).not.toBeNull();
  });

  it("an unknown base blocks Create with its own error; a listed one passes", async () => {
    await mount({ probeOf: {}, occupancyOf: {} });
    await settleProbe();
    expect(createBtn().disabled).toBe(false);
    type(baseInput()!, "dev");
    expect(errorText()).toBe("No such local branch");
    expect(createBtn().disabled).toBe(true);
    type(baseInput()!, "develop");
    expect(errorText()).toBeUndefined();
    expect(createBtn().disabled).toBe(false);
  });

  it("prefills the repo's current branch; a pick rides the result, cleared means HEAD", async () => {
    await mount({ probeOf: {}, occupancyOf: {} });
    await settleProbe();
    // The field names its default outright — no placeholder to decode.
    expect(baseInput()!.value).toBe("main");
    submit();
    type(baseInput()!, "develop");
    submit();
    type(baseInput()!, ""); // cleared = fork from the repo HEAD
    submit();
    expect(confirmed.map((r) => r.location)).toEqual([
      { kind: "new", path: "/base/kd-ws-2", branch: "kd/ws/2", baseBranch: "main" },
      { kind: "new", path: "/base/kd-ws-2", branch: "kd/ws/2", baseBranch: "develop" },
      { kind: "new", path: "/base/kd-ws-2", branch: "kd/ws/2", baseBranch: undefined },
    ]);
  });

  it("an unavailable branch list degrades to free text — never blocks the dialog", async () => {
    await mount({ probeOf: {}, occupancyOf: {}, branches: null });
    await settleProbe();
    type(baseInput()!, "anything-goes");
    expect(errorText()).toBeUndefined();
    expect(createBtn().disabled).toBe(false);
  });

  it("opens at full height: a prefilled path shows the fields before any probe", async () => {
    await mount({ probeOf: {}, occupancyOf: {} });
    // No settleProbe — the layout must not wait for the first probe.
    expect(branchInput()).not.toBeNull();
    expect(baseInput()).not.toBeNull();
    // …while Create still does: mid-probe nothing can be submitted.
    expect(createBtn().disabled).toBe(true);
    submit();
    expect(confirmed).toEqual([]);
  });

  it("editing the path keeps the fields mounted through the re-probe — no layout jump", async () => {
    await mount({ probeOf: {}, occupancyOf: {} });
    await settleProbe();
    expect(branchInput()).not.toBeNull();
    type(pathInput(), "/base/kd-ws-9");
    // Probe in flight ("Checking path…"): the fields hold their ground.
    expect(branchInput()).not.toBeNull();
    expect(baseInput()).not.toBeNull();
    expect(createBtn().disabled).toBe(true);
    await settleProbe();
    expect(branchInput()).not.toBeNull();
    expect(createBtn().disabled).toBe(false);
  });

  it("a path that settles as an existing worktree still drops the fields", async () => {
    await mount({ probeOf: { "/wt/other": WORKTREE }, occupancyOf: {} });
    await settleProbe();
    type(pathInput(), "/wt/other");
    expect(branchInput()).not.toBeNull(); // sticky while checking…
    await settleProbe();
    expect(branchInput()).toBeNull(); // …but the settled truth wins
    expect(baseInput()).toBeNull();
  });
});

describe("AgentDialog agent picker", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("each type button carries its agent's brand mark", async () => {
    await act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          repo: null,
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => [],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      ),
    );
    const button = document.querySelector(".form__type")!;
    expect(button.textContent).toContain("Claude Code");
    const svg = button.querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("#D97757");
    expect(svg.querySelector("path")!.getAttribute("d")).toBe("M0 0h24v24H0z");
  });
});
