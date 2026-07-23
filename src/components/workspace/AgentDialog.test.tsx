// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import type {
  AgentDialogResult,
  Occupancy,
  PathProbe,
  SessionPickRow,
} from "../../domain/agents";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The picker's resume gate probes directories via useDirPresence → the
// worktree ipc; pin it at the module seam (the dialog's PATH probe is a
// prop and stays unaffected).
const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

// The dialog pulls the agent catalog via useAgents; pin one agent at the
// hook seam (the real hook would bootstrap the real plugin system). The
// YOLO support flag is swappable per test — the toggle's visibility gates
// on it.
const catalog = vi.hoisted(() => ({
  supportsYolo: true,
  // Extra installed agents beyond claude — empty by default so every existing
  // test sees a single-agent catalog; a test can add one to exercise the
  // cross-agent guard.
  extraAgents: [] as unknown[],
}));
vi.mock("../../app/useAgents", () => ({
  useAgents: () => ({
    agents: [
      {
        id: "claude",
        label: "Claude Code",
        icon: {
          viewBox: "0 0 24 24",
          paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
        },
        command: "claude",
        supportsYolo: catalog.supportsYolo,
        installed: true,
        path: null,
      },
      ...catalog.extraAgents,
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
          remoteEnabled: false,
          defaultYolo: false,
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
          searchSessions: async () => ({ rows: [], total: 0 }),
          sessionClaim: () => null,
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
        yolo: false,
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
          remoteEnabled: false,
          defaultYolo: false,
          repo: null,
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => [],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions: async () => ({ rows: [], total: 0 }),
          sessionClaim: () => null,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      ),
    );
    const button = document.querySelector(".form__type")!;
    expect(button.textContent).toContain("Claude Code");
    const path = button.querySelector("svg path")!;
    expect(path.getAttribute("fill")).toBe("#D97757");
    expect(path.getAttribute("d")).toBe("M0 0h24v24H0z");
  });
});

describe("AgentDialog YOLO toggle", () => {
  let host: HTMLElement;
  let root: Root;
  let confirmed: AgentDialogResult[];

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    confirmed = [];
    catalog.supportsYolo = true;
  });
  afterEach(() => {
    act(() => root.unmount());
    catalog.supportsYolo = true;
  });

  const mount = (defaultYolo: boolean) =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo,
          repo: null,
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => [],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions: async () => ({ rows: [], total: 0 }),
          sessionClaim: () => null,
          onConfirm: (r: AgentDialogResult) => confirmed.push(r),
          onCancel: () => {},
        }),
      ),
    );

  const checkbox = () =>
    document.querySelector<HTMLInputElement>(".form__yolo input");

  it("prefills from the global default and the result carries the choice", async () => {
    await mount(true);
    expect(checkbox()?.checked).toBe(true);
    submit();
    expect(confirmed).toMatchObject([{ yolo: true }]);
  });

  it("unticking overrides the global default per spawn", async () => {
    await mount(true);
    act(() => checkbox()!.click());
    submit();
    expect(confirmed).toMatchObject([{ yolo: false }]);
  });

  it("hidden — and never true — for an agent without YOLO support", async () => {
    catalog.supportsYolo = false;
    await mount(true);
    expect(checkbox()).toBeNull();
    submit();
    // A remembered tick must not leak through a non-supporting agent.
    expect(confirmed).toMatchObject([{ yolo: false }]);
  });
});

describe("AgentDialog start-from session picker", () => {
  let host: HTMLElement;
  let root: Root;
  let confirmed: AgentDialogResult[];

  const SESSIONS: SessionPickRow[] = [
    {
      handle: { agent: "claude", sessionId: "s-live", cwd: "/repo/wt", title: "auth bug" },
      mtime: 3,
    },
    {
      handle: { agent: "claude", sessionId: "s-gone", cwd: "/gone", title: "old work" },
      mtime: 2,
    },
    {
      handle: { agent: "claude", sessionId: "s-claimed", cwd: "/repo/wt", title: "busy" },
      mtime: 1,
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    confirmed = [];
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      Promise.resolve({ exists: path !== "/gone", isWorktree: false, branch: null }),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const mount = () =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo: false,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => ["main"],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions: async () => ({ rows: SESSIONS, total: SESSIONS.length }),
          sessionClaim: (id: string) => (id === "s-claimed" ? ("running" as const) : null),
          onConfirm: (r: AgentDialogResult) => confirmed.push(r),
          onCancel: () => {},
        }),
      ),
    );

  const modeBtn = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".form__type")].find(
      (b) => b.textContent === label,
    )!;
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".form__session")];
  /** Let the shared engine's search debounce (150ms) fire, its page land, and
   * the presence probes settle. */
  const settleSessions = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {});
  };

  it("Resume lists sessions, locks the location away, and the result carries the pick", async () => {
    await mount();
    act(() => modeBtn("Resume").click());
    await settleSessions();

    expect(rows().map((r) => r.querySelector(".form__session-name")!.textContent)).toEqual(
      ["auth bug", "old work", "busy"],
    );
    // Location is the recorded cwd — the whole worktree block is gone.
    expect(document.querySelector('input[aria-label="Worktree path"]')).toBeNull();
    // Nothing picked yet → Create gated.
    expect(createBtn().disabled).toBe(true);

    act(() => rows()[0].click());
    // The pane name follows the session title while untouched.
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Agent name"]')!.value,
    ).toBe("auth bug");
    expect(document.body.textContent).toContain("Resumes in /repo/wt");
    expect(createBtn().disabled).toBe(false);
    expect(createBtn().textContent).toBe("Resume session");
    submit();
    expect(confirmed).toMatchObject([
      {
        name: "auth bug",
        session: { mode: "resume", handle: { sessionId: "s-live" } },
      },
    ]);
  });

  it("un-resumable rows are dimmed with the reason, and picking one keeps Create gated", async () => {
    await mount();
    act(() => modeBtn("Resume").click());
    await settleSessions();

    const gone = rows()[1];
    const claimed = rows()[2];
    expect(gone.className).toContain("form__session--blocked");
    expect(gone.textContent).toContain("directory is gone — fork instead");
    expect(claimed.className).toContain("form__session--blocked");
    expect(claimed.textContent).toContain("already in a pane");

    act(() => gone.click());
    expect(createBtn().disabled).toBe(true);
    expect(errorText()).toContain("directory is gone");
  });

  it("Fork keeps the location free and takes exactly the sessions resume refuses", async () => {
    await mount();
    act(() => modeBtn("Fork").click());
    await settleSessions();

    // The worktree field stays — a fork picks its own home.
    expect(document.querySelector('input[aria-label="Worktree path"]')).not.toBeNull();
    // No dimming in fork mode: these rows are what forking is FOR.
    expect(rows().every((r) => !r.className.includes("form__session--blocked"))).toBe(true);

    act(() => rows()[1].click()); // dir-gone — forkable
    expect(createBtn().disabled).toBe(false);
    submit();
    expect(confirmed).toMatchObject([
      {
        location: { kind: "main" },
        session: { mode: "fork", handle: { sessionId: "s-gone" } },
      },
    ]);
  });

  it("backing out to New session ignores the stale pick", async () => {
    await mount();
    act(() => modeBtn("Resume").click());
    await settleSessions();
    act(() => rows()[0].click());
    act(() => modeBtn("New session").click());
    expect(createBtn().disabled).toBe(false);
    expect(createBtn().textContent).toBe("Create agent");
    submit();
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].session).toBeUndefined();
  });
});

describe("AgentDialog start-from paging", () => {
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

  const mkRows = (from: number, count: number): SessionPickRow[] =>
    Array.from({ length: count }, (_, i) => ({
      handle: {
        agent: "claude",
        sessionId: `s-${from + i}`,
        cwd: "/repo/wt",
        title: `session ${from + i}`,
      },
      mtime: 1000 - (from + i),
    }));

  const modeBtn = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".form__type")].find(
      (b) => b.textContent === label,
    )!;
  const sessionRows = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".form__session")];

  it("pages the picker: pulls the next page at the loaded offset and shows the count", async () => {
    const calls: Array<{ limit: number; offset: number }> = [];
    // A first page of 50 with more behind it, then the 20-row tail — 70 total.
    const searchSessions = vi.fn(
      async (_agent: string, _query: string, limit: number, offset: number) => {
        calls.push({ limit, offset });
        return offset === 0
          ? { rows: mkRows(0, 50), total: 70 }
          : { rows: mkRows(50, 20), total: 70 };
      },
    );

    await act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo: false,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => ["main"],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions,
          sessionClaim: () => null,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      ),
    );

    // Fork avoids the resume presence gate — the paging itself is the subject.
    act(() => modeBtn("Fork").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {});

    // Page zero, then the scroll-fill pulled the next page at the loaded
    // offset — before this fix the list stopped at one page.
    expect(calls).toEqual([
      { limit: 50, offset: 0 },
      { limit: 20, offset: 50 },
    ]);
    expect(sessionRows()).toHaveLength(70);
    // Everything loaded → the bare total; a partial load reads "N of 70".
    expect(document.querySelector(".form__sessions-count")?.textContent).toBe(
      "70",
    );
  });

  it("shows the partial 'X of N' count while more pages remain", async () => {
    // Page zero is 50 of 200; the fill-triggered next page never resolves, so
    // the list stays partial and the count must read loaded-of-total.
    const searchSessions = vi.fn(
      async (_a: string, _q: string, _l: number, offset: number) =>
        offset === 0
          ? { rows: mkRows(0, 50), total: 200 }
          : new Promise<{ rows: SessionPickRow[]; total: number }>(() => {}),
    );

    await act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo: false,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => ["main"],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions,
          sessionClaim: () => null,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      ),
    );

    act(() => modeBtn("Fork").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {});

    // hasMore is true (50 of 200) and the second page is still loading.
    expect(document.querySelector(".form__sessions-count")?.textContent).toBe(
      "50 of 200",
    );
    expect(document.querySelector(".form__session-more")).not.toBeNull();
  });
});

describe("AgentDialog cross-agent pick guard", () => {
  let host: HTMLElement;
  let root: Root;
  let confirmed: AgentDialogResult[];

  // The picker keeps returning claude sessions even once codex is selected —
  // this mirrors the previous agent's rows still rendered during the search's
  // debounce window, where a click yields a cross-agent handle.
  const CLAUDE_SESSIONS: SessionPickRow[] = [
    {
      handle: { agent: "claude", sessionId: "s-c", cwd: "/repo/wt", title: "claude work" },
      mtime: 2,
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    confirmed = [];
    catalog.extraAgents = [
      {
        id: "codex",
        label: "Codex",
        icon: { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z", color: "#fff" }] },
        command: "codex",
        supportsYolo: false,
        installed: true,
        path: null,
      },
    ];
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    catalog.extraAgents = [];
  });

  const typeBtn = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".form__type")].find(
      (b) => b.textContent === text || b.textContent?.includes(text),
    )!;

  const mount = () =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo: false,
          repo: { cwd: "/repo", branch: "main" },
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => ["main"],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions: async () => ({
            rows: CLAUDE_SESSIONS,
            total: CLAUDE_SESSIONS.length,
          }),
          sessionClaim: () => null,
          onConfirm: (r: AgentDialogResult) => confirmed.push(r),
          onCancel: () => {},
        }),
      ),
    );

  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {});
  };

  const nameField = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Agent name"]')!;

  const pickFirstRow = () =>
    act(() =>
      document.querySelector<HTMLButtonElement>(".form__session")!.click(),
    );

  it("won't resume/fork a session whose agent differs from the selected agent", async () => {
    await mount();

    // Select codex, open Fork, pick the (claude) row.
    act(() => typeBtn("Codex").click());
    act(() => typeBtn("Fork").click());
    await settle();

    const row = document.querySelector<HTMLButtonElement>(".form__session")!;
    expect(row.textContent).toContain("claude work");
    act(() => row.click());

    // Cross-agent click is ignored: no name prefill, Create stays gated, and
    // confirm carries no session.
    expect(nameField().value).toBe("");
    expect(createBtn().disabled).toBe(true);
    submit();
    expect(confirmed).toEqual([]);
  });

  it("drops an auto-filled name when the agent is switched", async () => {
    await mount();
    // On claude, pick a session in Fork mode → the Name auto-fills from its title.
    act(() => typeBtn("Fork").click());
    await settle();
    await pickFirstRow();
    expect(nameField().value).toBe("claude work");
    // Switching agents voids the pick — the untouched name goes with it.
    act(() => typeBtn("Codex").click());
    expect(nameField().value).toBe("");
  });

  it("keeps a hand-edited name across an agent switch", async () => {
    await mount();
    act(() => typeBtn("Fork").click());
    await settle();
    await pickFirstRow();
    type(nameField(), "my agent");
    act(() => typeBtn("Codex").click());
    expect(nameField().value).toBe("my agent");
  });
});

describe("remote gating (Experimental setting)", () => {
  let root: Root;
  // A remote-capable codex added to the mocked catalog via `extraAgents`.
  const codexRemote = {
    id: "codex",
    label: "Codex",
    command: "codex",
    supportsYolo: false,
    supportsRemote: true,
    remoteSchemes: ["ws", "wss"],
    installed: true,
    path: null,
  };

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
    catalog.extraAgents = []; // don't leak the codex entry into other suites
  });

  const mount = (agent: string, remoteEnabled: boolean) =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          defaultAgentType: agent as AgentDialogResult["agentType"],
          defaultYolo: false,
          remoteEnabled,
          repo: null,
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => [],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions: async () => ({ rows: [], total: 0 }),
          sessionClaim: () => null,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      ),
    );

  it("hides the Where option when the Experimental setting is off", async () => {
    catalog.extraAgents = [codexRemote];
    await mount("codex", false);
    // codex declares remote + schemes, but the setting is off → hidden.
    expect(document.body.textContent).not.toContain("Where");
    expect(document.body.textContent).not.toContain("Remote");
  });

  it("shows the Where option for a remote-capable agent when the setting is on", async () => {
    catalog.extraAgents = [codexRemote];
    await mount("codex", true);
    expect(document.body.textContent).toContain("Where");
    expect(document.body.textContent).toContain("Remote");
  });

  it("hides Where for a non-remote agent even with the setting on", async () => {
    // claude never declares remote → no Where, regardless of the setting.
    await mount("claude", true);
    expect(document.body.textContent).not.toContain("Where");
  });
});
