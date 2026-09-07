// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDialogResult } from "../domain/agents";
import {
  TEAM_FULL_MESSAGE,
  placementRefusalMessage,
  type Workspace,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { inspectRepo } from "../ipc/worktree";
import { useAgentDialog } from "./useAgentDialog";
import { AppRuntimeProvider } from "./runtimeContext";
import type { AppRuntime } from "./runtime";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
  CreateTeamOutcome,
  CreateTeamRequest,
} from "./agentOrchestrator";
import type { Deck } from "./useDeck";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Per-path disk probes for suggestion filtering: paths in the map probe as a
// non-empty non-worktree dir (blocked); anything else as missing (free).
const blockedDirs = vi.hoisted(() => new Set<string>());

// The hook reaches the backend for repo inspection, name suggestions and path
// probes; pin all three (suggestions follow the real Rust naming:
// kd/<ws>/<i> ↔ kd-<ws>-<i>).
vi.mock("../ipc/worktree", () => ({
  inspectRepo: vi.fn(async () => ({
    isRepo: true,
    head: "abc",
    branch: "main",
  })),
  suggestWorktree: async (workspace: string, index: number) => ({
    branch: `kd/${workspace}/${index}`,
    folder: `kd-${workspace}-${index}`,
  }),
  probeWorktree: async (path: string) => ({
    exists: blockedDirs.has(path),
    isWorktree: false,
    empty: false,
    branch: null,
  }),
  createWorktree: async () => {
    throw new Error("not under test");
  },
  removeWorktree: async () => {},
}));

const workspace = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "KeepDeck",
  cwd: "/repo",
  worktreeBaseDir: "/base",
  panes: [],
  ...over,
});

/** A workspace with one team on the root and its lead — where the member
 * door opens. */
const withTeam = (over: Partial<Workspace> = {}): Workspace =>
  workspace({
    teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo" } }],
    panes: [{ id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } }],
    ...over,
  });
const MEMBER = { kind: "member" as const, teamId: "team-1" };

/** The one owner of what a new pane's arrival entails, as this hook sees it.
 * Requests are recorded, not landed: what the dialog OFFERS is this file's
 * subject; what the orchestrator then does with it is its own. */
const createPane = vi.fn<(request: CreatePaneRequest) => CreatePaneOutcome>(
  () => ({ kind: "created", teamId: "team-1" }),
);
/** The continuations the dialog's "Start from" routes into. Recorded here
 * too: this file's subject is the ROUTING — which continuation, with which
 * target — and what each one then does is the orchestrator's own test. */
const resumeSession = vi.fn(() => Promise.resolve());
const forkSession = vi.fn(() => Promise.resolve());
/** The "+ Team" door's own landing: a team and nothing else. */
const createTeam = vi.fn<(request: CreateTeamRequest) => CreateTeamOutcome>(() => ({
  kind: "created",
  teamId: "team-1",
}));
const runtime = {
  orchestrator: { createPane, createTeam, resumeSession, forkSession },
} as unknown as AppRuntime;
/** Where a failed continuation reports. A dialog that just closes on a failed
 * fork reads as success, so the wiring is worth asserting. */
const notices = {
  onResumeFailed: vi.fn(),
  onForkFailed: vi.fn(),
  onCreateFailed: vi.fn(),
  onTeamFailed: vi.fn(),
};
/** What the dialog asked for on its `n`th confirm. */
const offered = (n = 0) => createPane.mock.calls[n][0];
const mountHost = (
  root: Root,
  Host: (props: { deck: Deck }) => null,
  deck: Deck,
) =>
  root.render(
    createElement(AppRuntimeProvider, { runtime }, createElement(Host, { deck })),
  );

describe("useAgentDialog suggestions", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;

  function Host({ deck }: { deck: Deck }) {
    // No settings store seeded here: the default-agent preference falls back
    // to "claude" — these tests cover suggestions, not the type picker.
    // No journal routing and no blocked panes: these tests cover suggestions.
    flow = useAgentDialog(deck, [], notices, {});
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    blockedDirs.clear();
    createPane.mockClear();
    createTeam.mockClear();
    notices.onCreateFailed.mockClear();
    vi.mocked(inspectRepo).mockReset().mockResolvedValue({
      isRepo: true,
      head: "abc",
      branch: "main",
    });
  });
  afterEach(() => act(() => root.unmount()));

  const mount = async (ws: Workspace) => {
    const deck = { workspaces: [ws], addAgentPane: vi.fn(), openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    return deck;
  };

  it("prefills the first suggestion NOT held by a team", async () => {
    // One pane → the naive suggestion is index 2, but a team already runs in
    // kd-KeepDeck-2 (the reported bug): the prefill must skip to -3.
    const ws = workspace({
      teams: [
        {
          id: "team-1",
          name: "two",
          location: { kind: "attached", cwd: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2" },
        },
      ],
      panes: [{ id: "p1", team: { teamId: "team-1", role: "lead" } }],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("/base/kd-KeepDeck-3");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/3");
  });

  it("prefill also skips a dir blocked on disk (the leftover-folder bug)", async () => {
    // No pane holds kd-KeepDeck-1, but the folder exists with files (e.g. a
    // worktree removed outside the app): the prefill must not open the dialog
    // onto the blocked-path error — it skips to the first usable suggestion.
    blockedDirs.add("/base/kd-KeepDeck-1");
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("/base/kd-KeepDeck-2");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/2");
  });

  it("nextFree skips blocked dirs too", async () => {
    blockedDirs.add("/base/kd-KeepDeck-2");
    const ws = workspace({
      teams: [
        {
          id: "team-1",
          name: "one",
          location: { kind: "attached", cwd: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1" },
        },
      ],
      panes: [{ id: "p1", team: { teamId: "team-1", role: "lead" } }],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    const free = await flow.nextFree("/base/kd-KeepDeck-1");
    expect(free).toEqual({
      path: "/base/kd-KeepDeck-3",
      branch: "kd/KeepDeck/3",
    });
  });

  it("without a base folder the path stays empty but a branch is still suggested", async () => {
    const ws = workspace({ worktreeBaseDir: null });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/1");
  });

  it("branchFor maps a canonical folder to its canonical branch, else the folder name", async () => {
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws)); // branchFor works on the open dialog
    // The exact kd-<ws>-<n> shape resolves through the suggest IPC…
    expect(await flow.branchFor("/anywhere/kd-KeepDeck-7")).toBe("kd/KeepDeck/7");
    // …anything else — including a near-miss with a numeric tail — is taken
    // verbatim as the branch (the backend sanitizes at create time).
    expect(await flow.branchFor("/anywhere/fix-login")).toBe("fix-login");
    expect(await flow.branchFor("/anywhere/foo-3")).toBe("foo-3");
    expect(await flow.branchFor("")).toBeNull();
  });

  it("nextFree suggests beside the occupied path when the workspace has no base folder", async () => {
    const ws = workspace({
      worktreeBaseDir: null,
      teams: [{ id: "team-1", name: "two", location: { kind: "attached", cwd: "/elsewhere/kd-KeepDeck-2" } }],
      panes: [{ id: "p1", team: { teamId: "team-1", role: "lead" } }],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    const free = await flow.nextFree("/elsewhere/kd-KeepDeck-2");
    expect(free).toEqual({
      path: "/elsewhere/kd-KeepDeck-3",
      branch: "kd/KeepDeck/3",
    });
  });

  it("a picked base branch rides the new team's provisioning intent", async () => {
    const ws = workspace({});
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));

    await act(async () => {
      flow.confirm({
        agentType: "claude",
        name: "",
        location: {
          kind: "new",
          path: "/base/kd-KeepDeck-1",
          branch: "kd/KeepDeck/1",
          baseBranch: "develop",
        },
        yolo: false,
        teamName: "docs",
      });
    });

    // A team and nothing else lands: no pane is offered.
    expect(createPane).not.toHaveBeenCalled();
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(createTeam.mock.calls[0][0].placement).toMatchObject({
      kind: "provisioning",
      intent: { path: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1", base: "develop" },
    });
  });

  it("the YOLO choice lands on the pane — sparsely, only when armed", async () => {
    const ws = withTeam();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));

    const confirmMain = async (yolo: boolean) => {
      await act(async () => flow.openFor(ws, MEMBER));
      await act(async () => {
        flow.confirm({
          agentType: "claude",
          name: "",
          location: { kind: "main" },
          yolo,
        });
      });
    };

    await confirmMain(true);
    expect(offered(0).pane.yolo).toBe(true);

    await confirmMain(false);
    // Off never lands as an explicit false — the pane stays sparse.
    expect("yolo" in offered(1).pane).toBe(false);
  });

  it("a remote result creates a bare pane carrying the endpoint, on the team it joins", async () => {
    const ws = withTeam();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));

    await act(async () => flow.openFor(ws, MEMBER));
    await act(async () => {
      flow.confirm({
        agentType: "codex",
        name: "vps agent",
        location: { kind: "main" },
        yolo: false,
        remoteEndpoint: "ws://vps:4500",
      });
    });

    expect(createPane).toHaveBeenCalledTimes(1);
    const pane = offered().pane;
    expect(pane).toMatchObject({
      agentType: "codex",
      location: { kind: "remote", endpoint: "ws://vps:4500" },
    });
    // Remote is the pane's own placement; its thin client joins the team
    // by id like any member — no directory of its own is asked for.
    expect(offered().team).toBe("team-1");
    expect("placement" in offered()).toBe(false);
  });

  it("does not open after the workspace is replaced during repo inspection", async () => {
    const old = workspace({});
    let finishInspection!: (value: {
      isRepo: boolean;
      head: string;
      branch: string;
    }) => void;
    vi.mocked(inspectRepo).mockReturnValueOnce(
      new Promise((resolve) => {
        finishInspection = resolve;
      }),
    );
    await mount(old);

    let opening!: Promise<void>;
    await act(async () => {
      opening = flow.openFor(old);
      await Promise.resolve();
    });
    const replacement = workspace({ id: old.id });
    const replacementDeck = { workspaces: [replacement] } as unknown as Deck;
    await act(async () =>
      mountHost(root, Host, replacementDeck),
    );
    await act(async () => {
      finishInspection({ isRepo: true, head: "new", branch: "main" });
      await opening;
    });

    expect(flow.dialog).toBeNull();
  });

  it("says so when the workspace refuses the pane", async () => {
    // The dialog has already closed by the time the answer comes back, so a
    // dropped refusal is an agent the user asked for that never appears.
    const ws = withTeam();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, MEMBER));
    createPane.mockReturnValueOnce({ kind: "full" });

    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
      }),
    );
    expect(notices.onCreateFailed).toHaveBeenCalledWith(
      TEAM_FULL_MESSAGE,
    );
  });

  it("does not confirm into a replacement with the same public id", async () => {
    const old = workspace({});
    const oldDeck = { workspaces: [old] } as unknown as Deck;
    await act(async () => mountHost(root, Host, oldDeck));
    await act(async () => flow.openFor(old));

    const replacement = workspace({ id: old.id });
    const replacementDeck = { workspaces: [replacement] } as unknown as Deck;
    await act(async () =>
      mountHost(root, Host, replacementDeck),
    );
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
      }),
    );

    // The dialog never even offers the team: the workspace it opened for is
    // gone, and the one holding its id now is a different workspace.
    expect(createTeam).not.toHaveBeenCalled();
    expect(createPane).not.toHaveBeenCalled();
  });
});

describe("useAgentDialog start-from routing", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;


  const handle = {
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo/wt",
    title: "auth",
  };

  /** The revive sweep's gone-directory verdicts, as the hook receives them. */
  let blockedPanes: Record<string, string> = {};

  function Host({ deck }: { deck: Deck }) {
    flow = useAgentDialog(deck, [], notices, blockedPanes);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    blockedPanes = {};
    createPane.mockClear();
    resumeSession.mockClear();
    forkSession.mockClear();
    notices.onResumeFailed.mockClear();
    notices.onForkFailed.mockClear();
    notices.onCreateFailed.mockClear();
  });
  afterEach(() => act(() => root.unmount()));

  // A continuation is a MEMBER's door: a new team has no agent to start
  // from, and a member's resume runs where it was recorded while its fork
  // lands in the team's directory.
  const mountAndOpen = async (ws: Workspace) => {
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, MEMBER));
  };

  it("resume routes to the journal flow with the pane name — the location is not consulted", async () => {
    const ws = withTeam();
    await mountAndOpen(ws);
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "  api  ",
        // A leftover location from before the mode switch — must be ignored.
        location: { kind: "new", path: "/x", branch: "b" },
        yolo: false,
        session: { mode: "resume", handle },
      }),
    );
    expect(resumeSession).toHaveBeenCalledExactlyOnceWith("ws-1", handle, {
      name: "api",
      yolo: false,
    });
    expect(forkSession).not.toHaveBeenCalled();
    expect(createPane).not.toHaveBeenCalled(); // the journal flow owns the pane
  });

  it("resume routes the YOLO choice to the journal flow", async () => {
    const ws = withTeam();
    await mountAndOpen(ws);
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        // Resume ignores the location; only yolo + the handle ride.
        location: { kind: "main" },
        yolo: true,
        session: { mode: "resume", handle },
      }),
    );
    // The dialog already gates yolo on supportsYolo; confirm forwards the
    // resolved boolean verbatim — no re-gating in the handoff.
    expect(resumeSession).toHaveBeenLastCalledWith("ws-1", handle, {
      name: undefined,
      yolo: true,
    });
  });

  it("reports a failed resume — a dialog that just closes reads as success", async () => {
    const ws = withTeam();
    await mountAndOpen(ws);
    resumeSession.mockRejectedValueOnce(new Error("Agent could not prepare a resume plan"));
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
        session: { mode: "resume", handle },
      }),
    );
    expect(notices.onResumeFailed).toHaveBeenCalledWith(
      expect.stringContaining("could not prepare a resume plan"),
    );
    expect(notices.onForkFailed).not.toHaveBeenCalled();
  });

  it("reports a failed fork through its OWN notice, not the resume one", async () => {
    const ws = withTeam();
    await mountAndOpen(ws);
    forkSession.mockRejectedValueOnce(new Error("opencode fork: unexpected id layout"));
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: false,
        session: { mode: "fork", handle },
      }),
    );
    expect(notices.onForkFailed).toHaveBeenCalledWith(
      expect.stringContaining("unexpected id layout"),
    );
    expect(notices.onResumeFailed).not.toHaveBeenCalled();
  });

  it("fork lands in the team's directory whatever location the result carries", async () => {
    // A member runs where its team runs: the fork's home is the team's
    // directory, and a leftover location from before the mode switch has
    // no say in it.
    const ws = withTeam();
    const confirmFork = async (
      location: AgentDialogResult["location"],
    ) => {
      await act(async () => flow.openFor(ws, MEMBER));
      await act(async () =>
        flow.confirm({
          agentType: "claude",
          name: "",
          location,
          yolo: false,
          session: { mode: "fork", handle },
        }),
      );
    };
    await mountAndOpen(ws);

    for (const location of [
      { kind: "main" as const },
      { kind: "existing" as const, path: "/wt/x", branch: "kd/x" },
      { kind: "new" as const, path: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1", baseBranch: "develop" },
    ]) {
      await confirmFork(location);
      expect(forkSession).toHaveBeenLastCalledWith(
        "ws-1",
        handle,
        { kind: "dir", cwd: "/repo" },
        { name: undefined, yolo: false },
      );
    }
    expect(createPane).not.toHaveBeenCalled();
  });

  it("fork routes the YOLO choice to the journal flow", async () => {
    const ws = withTeam();
    await mountAndOpen(ws);
    await act(async () =>
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: true,
        session: { mode: "fork", handle },
      }),
    );
    // The dialog already gates yolo on supportsYolo; confirm forwards the
    // resolved boolean verbatim — no re-gating in the handoff.
    expect(forkSession).toHaveBeenLastCalledWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/repo" },
      { name: undefined, yolo: true },
    );
  });

  it("sessionClaim reads the panes' bindings, idle panes included", async () => {
    const ws = workspace({
      panes: [
        { id: "p1", session: { id: "s-run", boundAt: "2026-07-20T00:00:00Z" } },
        {
          id: "p2",
          idle: { reason: "suspended", at: "2026-07-20T01:00:00Z" },
          session: { id: "s-dorm", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-run")).toBe("running");
    expect(flow.sessionClaim("s-dorm")).toBe("stopped");
    expect(flow.sessionClaim("s-free")).toBeNull();
  });

  it("calls a pane stuck on a gone folder stopped, like every other surface", async () => {
    // Its model marker still says `waking` — only the sweep's runtime verdict
    // knows the directory is gone. The tile is dimmed and the tray chip
    // marked, but the picker was telling the user the session is "running in
    // a pane" and offering nothing to do about it.
    blockedPanes = { p1: "/gone/worktree" };
    const ws = workspace({
      panes: [
        {
          id: "p1",
          idle: { reason: "waking", origin: "restore" },
          session: { id: "s-blocked", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-blocked")).toBe("stopped");
  });

  it("still calls a pane merely on its way up running", async () => {
    const ws = workspace({
      panes: [
        {
          id: "p1",
          idle: { reason: "waking", origin: "restore" },
          session: { id: "s-rising", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim("s-rising")).toBe("running");
  });
});

describe("useAgentDialog targets", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;

  function Host({ deck }: { deck: Deck }) {
    flow = useAgentDialog(deck, [], notices, {});
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    createPane.mockClear();
    createPane.mockImplementation(() => ({ kind: "created", teamId: "team-1" }));
    createTeam.mockClear();
    createTeam.mockImplementation(() => ({ kind: "created", teamId: "team-2" }));
    forkSession.mockClear();
    notices.onCreateFailed.mockClear();
    notices.onTeamFailed.mockClear();
    notices.onForkFailed.mockClear();
    vi.mocked(inspectRepo).mockReset().mockResolvedValue({
      isRepo: true,
      head: "abc",
      branch: "main",
    });
  });
  afterEach(() => act(() => root.unmount()));

  const teamed = () =>
    workspace({
      teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/base/kd-KeepDeck-1" } }],
      panes: [{ id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } }],
    });
  const fresh = (): AgentDialogResult => ({
    agentType: "claude",
    name: "",
    location: { kind: "main" },
    yolo: false,
  });
  const handle = { agent: "claude", sessionId: "s-1", cwd: "/base/kd-KeepDeck-1", title: "t" };

  it("opens for a member with no location to ask about, and lands it on the team by id under the role picked", async () => {
    const ws = teamed();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    // No repo inspection, no suggestion: the member runs where the team runs
    // — and the picker knows what the roster holds.
    expect(inspectRepo).not.toHaveBeenCalled();
    expect(flow.dialog).toMatchObject({
      target: { kind: "member", teamId: "team-1", teamName: "api", cwd: "/base/kd-KeepDeck-1" },
      heldRoles: ["lead"],
      repo: null,
      suggestedPath: "",
    });

    await act(async () => flow.confirm({ ...fresh(), role: "impl-1" }));
    expect(offered()).toMatchObject({ team: "team-1", role: "impl-1" });
    expect("placement" in offered()).toBe(false);
    expect("teamName" in offered()).toBe(false);
    expect(createTeam).not.toHaveBeenCalled();
    // Joining a team is not entering it: the stage stays where it was.
    expect(deck.openTeam).not.toHaveBeenCalled();
  });

  it("opens no dialog for a member of a team that is gone, and offers no directory for one still creating", async () => {
    const creating = workspace({
      teams: [
        { id: "team-1", name: "api", location: { kind: "attached", cwd: "/base/kd-KeepDeck-1" } },
        {
          id: "team-2",
          name: "web",
          location: { kind: "provisioning", intent: { repo: "/repo", path: "/base/kd-KeepDeck-2", index: 2 } },
        },
      ],
    });
    const deck = { workspaces: [creating], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(creating, { kind: "member", teamId: "team-9" }));
    expect(flow.dialog).toBeNull();
    await act(async () => flow.openFor(creating, { kind: "member", teamId: "team-2" }));
    expect(flow.dialog).toMatchObject({ target: { kind: "member", teamId: "team-2", cwd: null } });
  });

  it("forks a member's session INTO the team's directory, and resumes where it was recorded", async () => {
    const ws = teamed();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    await act(async () =>
      flow.confirm({
        ...fresh(),
        name: "copy",
        role: "impl-2",
        session: { mode: "fork", handle },
      }),
    );
    // The role picked rides a continuation the same as a fresh start: a
    // forked member is a member, under the address the person chose.
    expect(forkSession).toHaveBeenCalledExactlyOnceWith(
      "ws-1",
      handle,
      { kind: "dir", cwd: "/base/kd-KeepDeck-1" },
      { name: "copy", yolo: false, role: "impl-2" },
    );
    expect(createPane).not.toHaveBeenCalled();

    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    await act(async () =>
      flow.confirm({ ...fresh(), role: "lead", session: { mode: "resume", handle } }),
    );
    expect(resumeSession).toHaveBeenCalledWith("ws-1", handle, {
      name: undefined,
      yolo: false,
      role: "lead",
    });
  });

  it("suggests the deck's next auto name for a new team, makes the team and nothing else, and enters it", async () => {
    const ws = teamed();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
    expect(flow.dialog).toMatchObject({
      target: { kind: "new-team", suggestedName: "Team 2" },
      heldRoles: [],
    });

    await act(async () =>
      flow.confirm({
        ...fresh(),
        teamName: "docs",
        location: { kind: "new", path: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2", baseBranch: "develop" },
      }),
    );
    // A team, at the directory the dialog chose, and no pane: the agents
    // come later, one at a time, through "+ Member".
    expect(createTeam).toHaveBeenCalledTimes(1);
    expect(createTeam.mock.calls[0][0]).toMatchObject({
      workspace: { id: "ws-1", instance: ws.instance },
      name: "docs",
      placement: {
        kind: "provisioning",
        intent: { repo: "/repo", path: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2", base: "develop" },
      },
    });
    expect(createPane).not.toHaveBeenCalled();
    expect(deck.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
  });

  it("says so when the team is full, when the directory is another team's, and when the name is taken", async () => {
    const ws = teamed();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    createPane.mockReturnValueOnce({ kind: "full" });
    await act(async () => flow.confirm(fresh()));
    expect(notices.onCreateFailed).toHaveBeenLastCalledWith(TEAM_FULL_MESSAGE);

    await act(async () => flow.openFor(ws));
    createTeam.mockReturnValueOnce({ kind: "held", why: "creating" });
    await act(async () => flow.confirm({ ...fresh(), teamName: "docs" }));
    expect(notices.onTeamFailed).toHaveBeenLastCalledWith(placementRefusalMessage("creating"));

    await act(async () => flow.openFor(ws));
    createTeam.mockReturnValueOnce({ kind: "taken" });
    await act(async () => flow.confirm({ ...fresh(), teamName: "api" }));
    expect(notices.onTeamFailed).toHaveBeenLastCalledWith(
      expect.stringContaining("“api” already exists"),
    );
    expect(deck.openTeam).not.toHaveBeenCalled();
  });

  it("asks instead of failing when the directory is another team's, and re-issues the create with the answer", async () => {
    const ws = teamed();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
    createTeam.mockReturnValueOnce({
      kind: "shared",
      directory: "/repo",
      holder: { teamId: "team-1", teamName: "api" },
    });
    await act(async () => flow.confirm({ ...fresh(), teamName: "docs" }));
    // Not a failure — nobody has been asked yet.
    expect(notices.onTeamFailed).not.toHaveBeenCalled();
    expect(flow.sharedAsk).toMatchObject({
      path: "/repo",
      holder: { teamId: "team-1", teamName: "api" },
    });
    // The "+ Team" dialog is closed while the question stands.
    expect(flow.dialog).toBeNull();

    createTeam.mockReturnValueOnce({ kind: "created", teamId: "team-2" });
    await act(async () => flow.sharedAsk!.confirm());
    // The SAME create, now carrying the answer.
    expect(createTeam).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "docs", shared: true }),
    );
    expect(deck.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
    expect(flow.sharedAsk).toBeNull();
  });

  it("drops the create when the question is cancelled", async () => {
    const ws = teamed();
    const deck = { workspaces: [ws], openTeam: vi.fn() } as unknown as Deck;
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
    createTeam.mockReturnValueOnce({
      kind: "shared",
      directory: "/repo",
      holder: { teamId: "team-1", teamName: "api" },
    });
    await act(async () => flow.confirm({ ...fresh(), teamName: "docs" }));
    createTeam.mockClear();
    await act(async () => flow.sharedAsk!.cancel());
    expect(flow.sharedAsk).toBeNull();
    expect(createTeam).not.toHaveBeenCalled();
    expect(deck.openTeam).not.toHaveBeenCalled();
  });
});
