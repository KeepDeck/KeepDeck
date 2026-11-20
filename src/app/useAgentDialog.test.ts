// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { presetPick, type AgentDialogResult, type AgentInfo } from "../domain/agents";
import { TEAM_FULL_MESSAGE, type Workspace } from "../domain/deck";
import type { IntentOutcome } from "../domain/lifecycle";
import type { JournalRecords } from "../domain/journal";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { indexSearch, type SearchHit } from "../ipc/history";
import { claimsOn, locationFor } from "../ipc/lifecycle";
import { intentOutcomeText } from "../presentation/lifecycleWords";
import { inspectRepo } from "../ipc/worktree";
import { createAgentDoors } from "./agentDoors";
import { useAgentDialog } from "./useAgentDialog";
import type { CreatePaneRequest, CreateTeamRequest } from "./agentOrchestrator";
import { present } from "@keepdeck/plugin-api/testing";

// The machine's answers the dialog reads: its next free place, and who holds
// a folder. Each case seeds what it needs.
vi.mock("../ipc/lifecycle", () => ({
  locationFor: vi.fn(async () => ({ place: { path: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1" }, held: null })),
  claimsOn: vi.fn(async () => []),
}));

// The log lines the hook writes, to read what a confirmed dialog said.
const logged = vi.hoisted((): string[] => []);
vi.mock("../ipc/log", () => ({
  log: {
    info: (target: string, message: string) => logged.push(`${target} ${message}`),
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// The picker's session search: whatever page a case seeds.
vi.mock("../ipc/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/history")>()),
  indexSearch: vi.fn(async () => ({ hits: [], total: 0 })),
}));

// The hook reaches the backend for repo inspection.
vi.mock("../ipc/worktree", () => ({
  inspectRepo: vi.fn(async () => ({
    isRepo: true,
    head: "abc",
    branch: "main",
  })),
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
const accepted = (team: string | null = null): IntentOutcome => ({
  kind: "accepted",
  op: 1,
  minted: { workspace: null, team, panes: team ? [] : ["pane-9"] },
});
const createPane = vi.fn(async (_request: CreatePaneRequest) => accepted());
/** The continuations the dialog's "Start from" routes into. Recorded here
 * too: this file's subject is the ROUTING — which continuation, with which
 * target — and what each one then does is the orchestrator's own test. */
const resumeSession = vi.fn(async () => accepted());
const forkSession = vi.fn(async () => accepted());
/** The "+ Team" door's own landing: a team and nothing else. */
const createTeam = vi.fn(async (_request: CreateTeamRequest) => accepted("team-1"));
const refusedWith = (reason: string): IntentOutcome => ({ kind: "refused", refusal: { kind: "rejected", reason } });
/** A deck as this file needs one: the workspaces the hook reads, and the
 * team entry the doors make after a "+ Team" — recorded, so a case can say
 * whether it happened. */
interface TestDeck {
  workspaces: Workspace[];
  journal: { records: JournalRecords };
  openTeam: Mock<(wsId: string, teamId: string) => void>;
}
const deckOf = (...workspaces: Workspace[]): TestDeck => ({
  workspaces,
  journal: { records: {} },
  openTeam: vi.fn(),
});
/** The deck the current Host was mounted with — what the doors owner reads
 * and enters teams through, exactly as the hook's own deck argument. */
let currentDeck: TestDeck;
// The doors owner over the same doubles: what the hook asks when a dialog
// is confirmed. Its own decisions are pinned in agentDoors.test; here the
// subject is what the hook OFFERS it and how it shows the answer.
const doors = createAgentDoors({
  orchestrator: { createPane, createTeam, resumeSession, forkSession },
  deck: {
    workspaces: () => currentDeck.workspaces,
    openTeam: (wsId, teamId) => currentDeck.openTeam(wsId, teamId),
  },
  // Who works in a folder, as the machine would say: the teams the deck
  // draws attached there.
  teamsIn: async (path) =>
    currentDeck.workspaces.flatMap((ws) =>
      (ws.teams ?? []).filter((team) => team.location?.kind === "attached" && team.location.cwd === path).map((team) => team.id),
    ),
});
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
  Host: (props: { deck: TestDeck }) => null,
  deck: TestDeck,
) => {
  currentDeck = deck;
  return root.render(createElement(Host, { deck }));
};

describe("useAgentDialog suggestions", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;
  /** The agent catalog the hook is handed; empty unless a case needs one. */
  let catalog: AgentInfo[] = [];

  function Host({ deck }: { deck: TestDeck }) {
    // No settings store seeded here: the default-agent preference falls back
    // to "claude" — these tests cover suggestions, not the type picker.
    // No journal routing and no blocked panes: these tests cover suggestions.
    flow = useAgentDialog(deck, catalog, notices, {}, doors);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    vi.mocked(locationFor).mockClear();
    vi.mocked(claimsOn).mockClear();
    catalog = [];
    logged.length = 0;
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
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    return deck;
  };

  it("says in the log what YOLO a confirmed member dialog sent, and why it may be off", async () => {
    // An agent that came up without the YOLO its person meant (task-576):
    // the line tells the toggle being off from the agent not taking one.
    const agent = (id: string, yolo: boolean): AgentInfo => ({
      id,
      label: id,
      command: id,
      features: yolo ? [{ id: "execution.yolo", label: "YOLO mode" }] : [],
      installed: true,
      path: null,
    });
    catalog = [agent("claude", true), agent("plain", false)];
    const ws = withTeam();
    await mount(ws);
    const confirm = async (agentType: string, yolo: boolean) => {
      await act(async () => flow.openFor(ws, MEMBER));
      await act(async () => {
        flow.confirm({ agentType, name: "", location: { kind: "main" }, yolo });
      });
    };

    await confirm("claude", true);
    await confirm("claude", false);
    await confirm("plain", false);

    // Each line names the team the trace hangs on — the one the member joins.
    expect(logged.filter((line) => line.includes("dialog confirmed"))).toEqual([
      "web:agents team-1: member dialog confirmed — claude, YOLO on",
      "web:agents team-1: member dialog confirmed — claude, YOLO off",
      "web:agents team-1: member dialog confirmed — plain, YOLO off (the agent declares no YOLO)",
    ]);
  });

  it("says no YOLO either way for a dialog that lands no agent", async () => {
    // "+ Team" submits its hidden picker's agent and the YOLO default; it
    // lands an empty team, so neither is what happened.
    catalog = [
      {
        id: "claude",
        label: "claude",
        command: "claude",
        features: [{ id: "execution.yolo", label: "YOLO mode" }],
        installed: true,
        path: null,
      },
    ];
    const ws = withTeam();
    await mount(ws);
    await act(async () => flow.openFor(ws));
    await act(async () => {
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "new", path: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1" },
        yolo: true,
        teamName: "docs",
      });
    });
    // A member confirmed with no agent picked is refused: no YOLO either.
    await act(async () => flow.openFor(ws, MEMBER));
    await act(async () => {
      flow.confirm({ agentType: null, name: "", location: { kind: "main" }, yolo: false });
    });
    expect(logged.filter((line) => line.includes("dialog confirmed"))).toEqual([
      expect.stringMatching(/new-team dialog confirmed — no agent, YOLO n\/a$/),
      expect.stringMatching(/member dialog confirmed — no agent, YOLO n\/a$/),
    ]);
  });

  it("tells the picker how each found session ran, as the journal recorded it in any workspace", async () => {
    // The index knows sessions, not modes: a continuation's YOLO starts
    // from the journal — the search is global, and so is what it knows —
    // and a session no journal recorded stays unknown.
    const hit = (sessionId: string): SearchHit => ({
      agent: "claude",
      sessionId,
      reference: sessionId,
      cwd: "/repo",
      title: null,
      transcriptPath: null,
      mtime: 1,
      snippet: null,
    });
    const record = (sessionId: string, yolo: boolean) => ({
      agent: "claude",
      sessionId,
      cwd: "/repo",
      boundAt: "t",
      state: "closed" as const,
      endedAt: "t",
      ...(yolo && { yolo: true }),
    });
    vi.mocked(indexSearch).mockResolvedValueOnce({
      hits: [hit("s-yolo"), hit("s-plain"), hit("s-elsewhere"), hit("s-unknown")],
      total: 4,
    });
    const ws = withTeam();
    const deck = await mount(ws);
    deck.journal.records = {
      // Recorded in another workspace too, as YOLO there: the dialog's own
      // workspace answers first — listed second, so key order cannot.
      "ws-2": [record("s-elsewhere", true), record("s-plain", true)],
      "ws-1": [record("s-yolo", true), record("s-plain", false)],
    };
    await act(async () => flow.openFor(ws, MEMBER));
    const page = await flow.searchSessions("claude", "", 50, 0);
    expect(page.rows.map((row) => [row.handle.sessionId, row.ranYolo])).toEqual([
      ["s-yolo", true],
      ["s-plain", false],
      ["s-elsewhere", true],
      ["s-unknown", undefined],
    ]);
  });

  it("traces a member dialog's YOLO from where it started, through every flip, to what it sent", async () => {
    catalog = [
      {
        id: "claude",
        label: "claude",
        command: "claude",
        features: [{ id: "execution.yolo", label: "YOLO mode" }],
        installed: true,
        path: null,
      },
    ];
    // The lead ran in YOLO, so its Fork opens on, and the implementer's
    // opens off; a fresh member opens on the global default — off, with no
    // settings store here.
    const ws = withTeam({
      panes: [
        {
          id: "p1",
          agentType: "claude",
          yolo: true,
          session: { id: "s-9", boundAt: "t" },
          team: { teamId: "team-1", role: "lead" },
        },
        {
          id: "p2",
          agentType: "claude",
          session: { id: "s-8", boundAt: "t" },
          team: { teamId: "team-1", role: "impl-1" },
        },
      ],
    });
    await mount(ws);
    await act(async () => flow.openFor(ws, MEMBER));
    act(() => flow.yoloToggled(true));
    act(() => flow.yoloToggled(false));
    act(() => flow.yoloToggled(true));
    await act(async () => {
      flow.confirm({ agentType: "claude", name: "", location: { kind: "main" }, yolo: true });
    });
    // A flip with no dialog open belongs to no trail.
    act(() => flow.yoloToggled(false));
    await act(async () => flow.forkPaneSession("ws-1", "p1"));
    const fork = present(flow.dialog, "the fork dialog");
    await act(async () => {
      flow.confirm({
        agentType: "claude",
        name: "",
        location: { kind: "main" },
        yolo: true,
        session: { mode: "fork", handle: present(fork.preset, "the fork preset").handle },
      });
    });
    await act(async () => flow.forkPaneSession("ws-1", "p2"));

    expect(logged.filter((line) => line.startsWith("web:agents "))).toEqual([
      "web:agents team-1: member dialog opened — YOLO starts off, the global default",
      "web:agents team-1: YOLO toggled on in the dialog",
      "web:agents team-1: YOLO toggled off in the dialog",
      "web:agents team-1: YOLO toggled on in the dialog",
      "web:agents team-1: member dialog confirmed — claude, YOLO on",
      "web:agents team-1: member dialog opened — YOLO starts on, as its source session ran",
      // What was continued is said beside the YOLO it sent: a start no flip
      // explains is the session's own.
      "web:agents team-1: member dialog confirmed — claude, fork of s-9, YOLO on",
      "web:agents team-1: member dialog opened — YOLO starts off, as its source session ran",
    ]);
  });

  it("prefills the machine's next free place for a new team", async () => {
    // Which number is free — not a team's, a create's, a cleanup's, nor
    // taken on disk — is the machine's rule; the dialog opens on its answer.
    vi.mocked(locationFor).mockResolvedValueOnce({ place: { path: "/base/kd-KeepDeck-3", branch: "kd/KeepDeck/3" }, held: null });
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(locationFor).toHaveBeenCalledWith("ws-1", null);
    expect(flow.dialog?.suggestedPath).toBe("/base/kd-KeepDeck-3");
    expect(flow.dialog?.suggestedBranch).toBe("kd/KeepDeck/3");
  });

  it("nextFree answers the machine's next free place", async () => {
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws));
    vi.mocked(locationFor).mockResolvedValueOnce({ place: { path: "/base/kd-KeepDeck-4", branch: "kd/KeepDeck/4" }, held: null });
    expect(await flow.nextFree()).toEqual({ path: "/base/kd-KeepDeck-4", branch: "kd/KeepDeck/4" });
    // A machine that cannot answer offers nothing; the field keeps its hint.
    vi.mocked(locationFor).mockRejectedValueOnce(new Error("down"));
    expect(await flow.nextFree()).toBeNull();
  });

  it("without a base folder the path stays empty, and the machine is not asked", async () => {
    const ws = workspace({ worktreeBaseDir: null });
    await mount(ws);
    await act(async () => flow.openFor(ws));
    expect(flow.dialog?.suggestedPath).toBe("");
    expect(flow.dialog?.suggestedBranch).toBe("");
    expect(locationFor).not.toHaveBeenCalled();
  });

  it("branchFor gives the machine's branch for the folder it suggested, else the folder name", async () => {
    const ws = workspace({});
    await mount(ws);
    await act(async () => flow.openFor(ws)); // branchFor works on the open dialog
    expect(await flow.branchFor("/elsewhere/kd-KeepDeck-1")).toBe("kd/KeepDeck/1");
    // Anything else is taken verbatim as the branch (the backend sanitizes
    // at create time).
    expect(await flow.branchFor("/anywhere/fix-login")).toBe("fix-login");
    expect(await flow.branchFor("/anywhere/kd-KeepDeck-7")).toBe("kd-KeepDeck-7");
    expect(await flow.branchFor("")).toBeNull();
  });

  it("asks the machine who holds a folder, as one spelling names it", async () => {
    const ws = workspace({});
    await mount(ws);
    vi.mocked(claimsOn).mockResolvedValueOnce([{ kind: "creation", op: 3 }]);
    expect(await flow.directoryAt("/base/kd-KeepDeck-2/")).toBe("held");
    expect(claimsOn).toHaveBeenCalledWith("/base/kd-KeepDeck-2");
  });

  it("a picked base branch rides the new team's site", async () => {
    const ws = workspace({});
    const deck = deckOf(ws);
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
    expect(createTeam.mock.calls[0][0].site).toEqual({
      kind: "new",
      place: { path: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1" },
      base: "develop",
    });
  });

  it("the YOLO choice lands on the pane — sparsely, only when armed", async () => {
    const ws = withTeam();
    const deck = deckOf(ws);
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
    const deck = deckOf(ws);
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
    expect("site" in offered()).toBe(false);
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
    const replacementDeck = deckOf(replacement);
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
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, MEMBER));
    createPane.mockResolvedValueOnce(refusedWith(TEAM_FULL_MESSAGE));

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
    const oldDeck = deckOf(old);
    await act(async () => mountHost(root, Host, oldDeck));
    await act(async () => flow.openFor(old));

    const replacement = workspace({ id: old.id });
    const replacementDeck = deckOf(replacement);
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

  function Host({ deck }: { deck: TestDeck }) {
    flow = useAgentDialog(deck, [], notices, blockedPanes, doors);
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
    const deck = deckOf(ws);
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
    // No role picked: it rides as asked — empty — for the role rule to refuse.
    expect(resumeSession).toHaveBeenCalledExactlyOnceWith("ws-1", handle, {
      team: "team-1",
      name: "api",
      yolo: false,
      role: "",
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
      team: "team-1",
      name: undefined,
      yolo: true,
      role: "",
    });
  });

  it("reports a failed resume — a dialog that just closes reads as success", async () => {
    const ws = withTeam();
    await mountAndOpen(ws);
    resumeSession.mockResolvedValueOnce(refusedWith("the agent could not prepare a resume plan"));
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
    forkSession.mockResolvedValueOnce(refusedWith("opencode fork: unexpected id layout"));
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
        { name: undefined, yolo: false, role: "", team: "team-1" },
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
      { name: undefined, yolo: true, role: "", team: "team-1" },
    );
  });

  it("sessionClaim reads the panes' bindings, idle panes included", async () => {
    const ws = workspace({
      panes: [
        { id: "p1", agentType: "claude", session: { id: "s-run", boundAt: "2026-07-20T00:00:00Z" } },
        {
          id: "p2",
          agentType: "claude",
          idle: { reason: "suspended", at: "2026-07-20T01:00:00Z" },
          session: { id: "s-dorm", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim({ agent: "claude", sessionId: "s-run" })).toBe("running");
    expect(flow.sessionClaim({ agent: "claude", sessionId: "s-dorm" })).toBe("stopped");
    expect(flow.sessionClaim({ agent: "claude", sessionId: "s-free" })).toBeNull();
    // Another CLI's session of the same id is not held by a claude pane.
    expect(flow.sessionClaim({ agent: "codex", sessionId: "s-run" })).toBeNull();
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
          agentType: "claude",
          idle: { reason: "waking", origin: "restore" },
          session: { id: "s-blocked", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim({ agent: "claude", sessionId: "s-blocked" })).toBe("stopped");
  });

  it("still calls a pane merely on its way up running", async () => {
    const ws = workspace({
      panes: [
        {
          id: "p1",
          agentType: "claude",
          idle: { reason: "waking", origin: "restore" },
          session: { id: "s-rising", boundAt: "2026-07-20T00:00:00Z" },
        },
      ],
    });
    await mountAndOpen(ws);
    expect(flow.sessionClaim({ agent: "claude", sessionId: "s-rising" })).toBe("running");
  });
});

describe("useAgentDialog targets", () => {
  let host: HTMLElement;
  let root: Root;
  let flow: ReturnType<typeof useAgentDialog>;

  function Host({ deck }: { deck: TestDeck }) {
    flow = useAgentDialog(deck, [], notices, {}, doors);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    createPane.mockClear();
    createPane.mockImplementation(async () => accepted());
    createTeam.mockClear();
    createTeam.mockImplementation(async () => accepted("team-2"));
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

  it("opens a busy card's Fork as the member dialog, its bound session picked on its agent — the role left to choose", async () => {
    const ws = workspace({
      teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/base/kd-KeepDeck-1" } }],
      panes: [
        {
          id: "p1",
          agentType: "codex",
          session: { id: "s-9", boundAt: "t" },
          team: { teamId: "team-1", role: "lead" },
        },
        // On no team: nothing to open the member dialog for.
        { id: "p2", agentType: "claude", session: { id: "s-8", boundAt: "t" } },
      ],
    });
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.forkPaneSession("ws-1", "p2"));
    expect(flow.dialog).toBeNull();
    await act(async () => flow.forkPaneSession("ws-1", "p1"));
    expect(flow.dialog).toMatchObject({
      target: { kind: "member", teamId: "team-1" },
      defaultAgentType: "codex",
      preset: { mode: "fork", handle: { agent: "codex", sessionId: "s-9", cwd: "/base/kd-KeepDeck-1" } },
    });
    expect(present(flow.dialog, "the open dialog").roles.addressFor("lead")).toBeNull();
  });

  it("opens a Fork carrying how its source pane ran — the toggle starts from that, not the global default", async () => {
    // No settings store here: the global default reads as off. The spec
    // says so; the preset says how the source ran, which is what the
    // dialog's toggle starts from ([`presetPick`], `dialogStartingYolo`).
    const ws = workspace({
      teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/base/kd-KeepDeck-1" } }],
      panes: [
        { id: "p1", agentType: "codex", yolo: true, session: { id: "s-9", boundAt: "t" }, team: { teamId: "team-1", role: "lead" } },
        { id: "p2", agentType: "codex", session: { id: "s-8", boundAt: "t" }, team: { teamId: "team-1", role: "impl-1" } },
      ],
    });
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    const opensOn = () => {
      const dialog = present(flow.dialog, "the open dialog");
      expect(dialog.defaultYolo).toBe(false);
      return presetPick(present(dialog.preset, "the fork preset")).ranYolo;
    };
    await act(async () => flow.forkPaneSession("ws-1", "p1"));
    expect(opensOn()).toBe(true);
    await act(async () => flow.cancel());
    await act(async () => flow.forkPaneSession("ws-1", "p2"));
    expect(opensOn()).toBe(false);
  });

  it("opens for a member with no location to ask about, and lands it on the team by id under the role picked", async () => {
    const ws = teamed();
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    // No repo inspection, no suggestion: the member runs where the team runs
    // — and the picker knows what the roster holds.
    expect(inspectRepo).not.toHaveBeenCalled();
    expect(flow.dialog).toMatchObject({
      target: { kind: "member", teamId: "team-1", teamName: "api", cwd: "/base/kd-KeepDeck-1" },
      repo: null,
      suggestedPath: "",
    });
    // The picker's data is built against the roster the team holds.
    expect(present(flow.dialog, "the open dialog").roles.addressFor("lead")).toBeNull();
    expect(present(flow.dialog, "the open dialog").roles.addressFor("impl")).toBe("impl-1");

    await act(async () => flow.confirm({ ...fresh(), role: "impl-1" }));
    expect(offered()).toMatchObject({ team: "team-1", role: "impl-1" });
    expect("site" in offered()).toBe(false);
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
    const deck = deckOf(creating);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(creating, { kind: "member", teamId: "team-9" }));
    expect(flow.dialog).toBeNull();
    await act(async () => flow.openFor(creating, { kind: "member", teamId: "team-2" }));
    expect(flow.dialog).toMatchObject({ target: { kind: "member", teamId: "team-2", cwd: null } });
  });

  it("forks a member's session INTO the team's directory, and resumes where it was recorded", async () => {
    const ws = teamed();
    const deck = deckOf(ws);
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
      { name: "copy", yolo: false, team: "team-1", role: "impl-2" },
    );
    expect(createPane).not.toHaveBeenCalled();

    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    await act(async () =>
      flow.confirm({ ...fresh(), role: "lead", session: { mode: "resume", handle } }),
    );
    expect(resumeSession).toHaveBeenCalledWith("ws-1", handle, {
      team: "team-1",
      name: undefined,
      yolo: false,
      role: "lead",
    });
  });

  it("suggests the deck's next auto name for a new team, makes the team and nothing else, and enters it", async () => {
    const ws = teamed();
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
    expect(flow.dialog).toMatchObject({
      target: { kind: "new-team", suggestedName: "Team 2" },
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
    expect(createTeam.mock.calls[0][0]).toEqual({
      workspace: { id: "ws-1", instance: ws.instance },
      name: "docs",
      site: { kind: "new", place: { path: "/base/kd-KeepDeck-2", branch: "kd/KeepDeck/2" }, base: "develop" },
    });
    expect(createPane).not.toHaveBeenCalled();
    expect(deck.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
  });

  it("says so when the team is full, when the machine refuses the place, and when the name is taken", async () => {
    const ws = teamed();
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws, { kind: "member", teamId: "team-1" }));
    createPane.mockResolvedValueOnce(refusedWith(TEAM_FULL_MESSAGE));
    await act(async () => flow.confirm({ ...fresh(), role: "impl-1" }));
    expect(notices.onCreateFailed).toHaveBeenLastCalledWith(TEAM_FULL_MESSAGE);

    await act(async () => flow.openFor(ws));
    const held: IntentOutcome = { kind: "refused", refusal: { kind: "locationHeld" } };
    createTeam.mockResolvedValueOnce(held);
    await act(async () => flow.confirm({ ...fresh(), teamName: "docs" }));
    expect(notices.onTeamFailed).toHaveBeenLastCalledWith(intentOutcomeText(held));

    await act(async () => flow.openFor(ws));
    await act(async () => flow.confirm({ ...fresh(), teamName: "api" }));
    expect(notices.onTeamFailed).toHaveBeenLastCalledWith(
      expect.stringContaining("“api” already exists"),
    );
    expect(deck.openTeam).not.toHaveBeenCalled();
  });

  /** "+ Team" at the folder team-1 already works in. */
  const intoTeamOnes = (): AgentDialogResult => ({
    ...fresh(),
    teamName: "docs",
    location: { kind: "existing", path: "/base/kd-KeepDeck-1", branch: "kd/KeepDeck/1" },
  });

  it("asks instead of failing when the directory is another team's, and makes the team on the answer", async () => {
    const ws = teamed();
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
    await act(async () => flow.confirm(intoTeamOnes()));
    // Not a failure — nobody has been asked yet, and nothing was made.
    expect(notices.onTeamFailed).not.toHaveBeenCalled();
    expect(createTeam).not.toHaveBeenCalled();
    expect(flow.sharedAsk).toMatchObject({
      path: "/base/kd-KeepDeck-1",
      holder: { teamId: "team-1", teamName: "api" },
    });
    // The "+ Team" dialog is closed while the question stands.
    expect(flow.dialog).toBeNull();

    await act(async () => present(flow.sharedAsk, "the shared-name ask").confirm());
    expect(createTeam).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "docs", site: { kind: "existing", cwd: "/base/kd-KeepDeck-1" } }),
    );
    expect(deck.openTeam).toHaveBeenCalledWith("ws-1", "team-2");
    expect(flow.sharedAsk).toBeNull();
  });

  it("drops the create when the question is cancelled", async () => {
    const ws = teamed();
    const deck = deckOf(ws);
    await act(async () => mountHost(root, Host, deck));
    await act(async () => flow.openFor(ws));
    await act(async () => flow.confirm(intoTeamOnes()));
    createTeam.mockClear();
    await act(async () => present(flow.sharedAsk, "the shared-name ask").cancel());
    expect(flow.sharedAsk).toBeNull();
    expect(createTeam).not.toHaveBeenCalled();
    expect(deck.openTeam).not.toHaveBeenCalled();
  });
});
