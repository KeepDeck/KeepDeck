// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { useAgentDialog as UseAgentDialog } from "./useAgentDialog";
import { presetPick } from "../domain/agents";
import { callsOf, useHost } from "../testing/host/host";
import { quitAfter, startDeck, type Deck } from "../testing/host/deck";
import type { StubAgentControl } from "../testing/host/stubPlugin";

/** What the agent dialog hook holds, as the app's controller hands it. */
type Flow = ReturnType<typeof UseAgentDialog>;

/**
 * The agent dialog on the app itself: the hook mounted in the deck's own
 * page over what the app's controller hands it — the deck, the agents its
 * plugins declare, the panes its run view holds back, and the doors that
 * land a confirmed dialog — with the machine answering where a team goes.
 */
describe("the agent dialog, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;
  let unmount: (() => void) | null = null;

  afterEach(() => {
    unmount?.();
    unmount = null;
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const until = (label: string, ok: () => boolean, ms = 15_000) => host().until(label, ok, ms);
  /** The page's own log lines that carry `text`, in order. */
  const logged = (text: string) => host().tape.filter(({ way, line }) => way === "page log" && line.includes(text)).map(({ line }) => line);

  /** Mount the hook in the deck's page, as `useAppController` does — its
   * modules the deck's own, loaded after it started. What it reports a
   * failure with is kept. */
  async function dialogOn(d: Deck) {
    const { useAgentDialog } = await import("./useAgentDialog");
    const { useDeck } = await import("./useDeck");
    const { useAgentsFrom } = await import("./useAgents");
    const { useAgentRunView } = await import("./useAgentRunView");
    const failures: string[] = [];
    const notices = {
      onResumeFailed: (message: string) => failures.push(`resume: ${message}`),
      onForkFailed: (message: string) => failures.push(`fork: ${message}`),
      onCreateFailed: (message: string) => failures.push(`create: ${message}`),
      onTeamFailed: (message: string) => failures.push(`team: ${message}`),
    };
    let flow: Flow | null = null;
    function Host() {
      const shown = useDeck(d.runtime.deckStore);
      const { agents } = useAgentsFrom(d.runtime.plugins);
      const view = useAgentRunView(d.runtime.orchestrator);
      flow = useAgentDialog(shown, agents, notices, view.blocked, d.runtime.agentDoors);
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(Host)));
    unmount = () => act(() => root.unmount());
    const current = (): Flow => {
      if (!flow) throw new Error("the dialog hook did not mount");
      return flow;
    };
    return { flow: current, failures };
  }

  /** The first workspace's first team. */
  const teamOf = (d: Deck) => {
    const teamId = d.workspace().teams?.[0]?.id;
    if (!teamId) throw new Error("no team on the deck");
    return teamId;
  };
  /** The dialog's lines about `teamId`'s dialogs, as said: what opened, each
   * flip, what was sent. */
  const trail = (teamId: string) => logged(`${teamId}: `).map((line) => line.replace(/^.*?\] /, "")).filter((line) => /dialog (opened|confirmed)|toggled/.test(line));
  /** The panes the deck holds now that it did not before. */
  const newPanes = (d: Deck, before: readonly string[]) => d.workspace().panes.filter((pane) => !before.includes(pane.id));

  describe("what a confirmed dialog says", () => {
    it("says in the log what YOLO a confirmed member dialog sent", async () => {
      const d = await open({ yolo: true });
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      for (const [yolo, role] of [[true, "impl-1"], [false, "impl-2"]] as const) {
        await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
        await act(async () => {
          flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo, role });
        });
      }
      await until("both are said", () => logged("dialog confirmed").length === 2);
      expect(trail(teamId).filter((line) => line.includes("confirmed"))).toEqual([
        `${teamId}: member dialog confirmed — stub, YOLO on`,
        `${teamId}: member dialog confirmed — stub, YOLO off`,
      ]);
    });

    it("says why YOLO is off for an agent whose plugin declares none", async () => {
      const d = await open({ yolo: false });
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo: false, role: "impl-1" });
      });
      await until("it is said", () => logged("dialog confirmed").length === 1);
      expect(trail(teamId).filter((line) => line.includes("confirmed"))).toEqual([`${teamId}: member dialog confirmed — stub, YOLO off (the agent declares no YOLO)`]);
    });

    it("says no YOLO either way for a dialog that lands no agent", async () => {
      const d = await open({ yolo: true });
      d.gitRepo();
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      // "+ Team" submits its hidden picker's agent and the YOLO default; it
      // lands an empty team, so neither is what happened.
      await act(async () => flow().openFor(d.workspace()));
      const team = flow().dialog;
      if (!team) throw new Error("no team dialog");
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "new", path: team.suggestedPath, branch: team.suggestedBranch }, yolo: true, teamName: "docs" });
      });
      // A member confirmed with no agent picked is refused: no YOLO either.
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
      await act(async () => {
        flow().confirm({ agentType: null, name: "", location: { kind: "main" }, yolo: false });
      });
      await until("both are said", () => logged("dialog confirmed").length === 2);
      expect(logged("dialog confirmed")).toEqual([expect.stringMatching(/new-team dialog confirmed — no agent, YOLO n\/a$/), expect.stringMatching(/member dialog confirmed — no agent, YOLO n\/a$/)]);
    });

    it("traces a member dialog's YOLO from where it started, through every flip, to what it sent", async () => {
      // The lead ran in YOLO, so its Fork opens on, and the reviewer's opens
      // off; a fresh member opens on the global default — off.
      const d = await open({ yolo: true });
      await d.workspaceUp();
      const lead = await d.addAgent({ role: "lead", yolo: true });
      const session = await d.upAndBound(lead);
      const teamId = teamOf(d);
      const reviewer = await d.memberUp(teamId, "reviewer");
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
      act(() => flow().yoloToggled(true));
      act(() => flow().yoloToggled(false));
      act(() => flow().yoloToggled(true));
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo: true, role: "impl-1" });
      });
      // A flip with no dialog open belongs to no trail.
      act(() => flow().yoloToggled(false));
      await act(async () => flow().forkPaneSession(d.workspace().id, lead));
      const fork = flow().dialog?.preset;
      if (!fork) throw new Error("no fork dialog");
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo: true, role: "impl-2", session: { mode: "fork", handle: fork.handle } });
      });
      await act(async () => flow().forkPaneSession(d.workspace().id, reviewer));
      await until("the last dialog opened", () => trail(teamId).length === 8);
      expect(trail(teamId)).toEqual([
        `${teamId}: member dialog opened — YOLO starts off, the global default`,
        `${teamId}: YOLO toggled on in the dialog`,
        `${teamId}: YOLO toggled off in the dialog`,
        `${teamId}: YOLO toggled on in the dialog`,
        `${teamId}: member dialog confirmed — stub, YOLO on`,
        `${teamId}: member dialog opened — YOLO starts on, as its source session ran`,
        `${teamId}: member dialog confirmed — stub, fork of ${session}, YOLO on`,
        `${teamId}: member dialog opened — YOLO starts off, as its source session ran`,
      ]);
    });
  });

  describe("where a new team goes", () => {
    /** The machine's own answer for the workspace's next free place. */
    const machineSays = async (wsId: string) => {
      const { locationFor } = await import("../ipc/lifecycle");
      return (await locationFor(wsId, null)).place;
    };

    it("opens on the machine's next free place for a new team", async () => {
      const d = await open();
      d.gitRepo();
      const ws = await d.workspaceUp();
      const { flow } = await dialogOn(d);
      const from = host().tape.length;
      await act(async () => flow().openFor(d.workspace()));
      expect(callsOf(host(), "lifecycle_location", from)).toEqual([{ workspace: ws.id, candidate: null }]);
      const place = await machineSays(ws.id);
      expect(flow().dialog).toMatchObject({ suggestedPath: place?.path, suggestedBranch: place?.branch });
    });

    it("asks the machine for the next free place again, and offers nothing when it cannot say", async () => {
      const d = await open();
      d.gitRepo();
      const ws = await d.workspaceUp();
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace()));
      const place = await machineSays(ws.id);
      expect(await flow().nextFree()).toEqual(place);
      host().fail("lifecycle_location");
      expect(await flow().nextFree()).toBeNull();
    });

    it("leaves the place empty, and asks the machine nothing, in a workspace with no folder for new teams", async () => {
      const d = await open();
      d.gitRepo();
      const made = await d.runtime.orchestrator.createWorkspace({ name: "ws", cwd: host().work, worktreeBaseDir: null });
      expect(made.kind).toBe("accepted");
      const { flow } = await dialogOn(d);
      const from = host().tape.length;
      await act(async () => flow().openFor(d.workspace()));
      expect(flow().dialog).toMatchObject({ suggestedPath: "", suggestedBranch: "" });
      expect(callsOf(host(), "lifecycle_location", from)).toEqual([]);
    });

    it("names the machine's branch for a folder of its scheme, and any other folder by its own name", async () => {
      const d = await open();
      d.gitRepo();
      await d.workspaceUp();
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace()));
      const team = flow().dialog;
      if (!team) throw new Error("no team dialog");
      const scheme = team.suggestedPath.slice(team.suggestedPath.lastIndexOf("/") + 1);
      expect(await flow().branchFor(`/elsewhere/${scheme}`)).toBe(team.suggestedBranch);
      // Anything else is taken as the branch verbatim: the backend
      // sanitizes it when it makes the branch.
      expect(await flow().branchFor("/anywhere/fix-login")).toBe("fix-login");
      expect(await flow().branchFor("")).toBeNull();
    });

    it("asks the machine who holds a folder, as one spelling of it names it", async () => {
      const d = await open();
      await d.agentUp();
      const { flow } = await dialogOn(d);
      const from = host().tape.length;
      // The workspace's own team works in its root: asked with a trailing
      // slash, the machine is asked of the folder as it keys it, and says so.
      expect(await flow().directoryAt(`${host().work}/`)).toBe("worked-in");
      expect(callsOf(host(), "lifecycle_claims", from)).toEqual([{ path: host().work }]);
    });

    it("says so when the machine refuses the member it was asked for", async () => {
      // The dialog has closed by the time the answer comes back: a refusal
      // dropped is an agent the person asked for that never appears.
      const d = await open();
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow, failures } = await dialogOn(d);
      const before = d.workspace().panes.map((pane) => pane.id);
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
      // Its lead is the one lead the team has.
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo: false, role: "lead" });
      });
      await until("the refusal is said", () => failures.length > 0);
      expect(failures).toEqual([expect.stringMatching(/^create: .+/)]);
      expect(newPanes(d, before)).toEqual([]);
    });

    it("sends a picked base branch with the new team's site, and lands the team alone", async () => {
      const d = await open();
      d.gitRepo();
      execFileSync("git", ["branch", "develop"], { cwd: host().work });
      await d.workspaceUp();
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace()));
      const team = flow().dialog;
      if (!team) throw new Error("no team dialog");
      const asked = d.intents().length;
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "new", path: team.suggestedPath, branch: team.suggestedBranch, baseBranch: "develop" }, yolo: false, teamName: "docs" });
      });
      await until("the team is asked for", () => d.intents().length > asked);
      expect(d.intents().slice(asked)).toEqual([
        expect.objectContaining({ site: { kind: "new", place: { path: team.suggestedPath, branch: team.suggestedBranch }, base: "develop" } }),
      ]);
      await until("the team stands", () => (d.workspace().teams ?? []).some((made) => made.name === "docs"));
      expect(d.workspace().panes).toEqual([]);
    });
  });

  describe("starting from a session", () => {
    /** A session the stub can take up — as a CLI's own store holds one
     * recorded in the team's directory. */
    const handle = () => ({ agent: "stub", sessionId: "s-old", cwd: host().work, title: "auth" });
    /** The continuations the page asked of the machine since `from`. */
    const continued = (d: Deck, from: number) => d.intents().slice(from).filter((intent) => intent.kind === "continue");
    /** A member dialog confirmed to start from the session, as `mode`. */
    const startFrom = async (d: Deck, flow: () => Flow, mode: "resume" | "fork", over: { name?: string; yolo?: boolean; role: string; location?: Parameters<Flow["confirm"]>[0]["location"] }) => {
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId: teamOf(d) }));
      await act(async () => {
        flow().confirm({ agentType: "stub", name: over.name ?? "", location: over.location ?? { kind: "main" }, yolo: over.yolo ?? false, role: over.role, session: { mode, handle: handle() } });
      });
    };

    it("resumes onto the team with the pane's name and YOLO, whatever location was left in the form", async () => {
      const d = await open({ yolo: true });
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      const from = d.intents().length;
      // A location left over from before the mode switch: it has no say.
      await startFrom(d, flow, "resume", { name: "  api  ", yolo: true, role: "impl-1", location: { kind: "new", path: "/x", branch: "b" } });
      await until("it is asked for", () => continued(d, from).length === 1);
      expect(continued(d, from)).toEqual([
        expect.objectContaining({ how: "resume", landing: { kind: "team", team: teamId }, source: { agent: "stub", session: "s-old" }, member: expect.objectContaining({ name: "api", yolo: true, role: "impl-1" }) }),
      ]);
      expect(d.intents().slice(from).some((intent) => intent.kind === "seat")).toBe(false);
    });

    it("asks for a continued member trimmed and sparse: no name for a blank one, no YOLO for one off", async () => {
      // The continue door hands its YOLO on as an explicit false; what is
      // written is the member's draft at the door's.
      const d = await open({ yolo: true });
      await d.agentUp();
      const { flow } = await dialogOn(d);
      const from = d.intents().length;
      await startFrom(d, flow, "resume", { name: "   ", yolo: false, role: "impl-1" });
      await until("it is asked for", () => continued(d, from).length === 1);
      const [intent] = continued(d, from);
      const member = intent?.kind === "continue" ? intent.member : undefined;
      expect(member).toMatchObject({ role: "impl-1" });
      expect(member).not.toHaveProperty("yolo");
      expect(member).not.toHaveProperty("name");
    });

    it("forks into the team's own directory, whatever location was left in the form, with the YOLO picked", async () => {
      const d = await open({ yolo: true });
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      const from = d.intents().length;
      const leftovers = [
        { kind: "main" as const },
        { kind: "existing" as const, path: "/wt/x", branch: "kd/x" },
        { kind: "new" as const, path: join(host().trees, "kd-x-1"), branch: "kd/x/1", baseBranch: "develop" },
      ];
      for (const [n, location] of leftovers.entries()) {
        await startFrom(d, flow, "fork", { yolo: n === 0, role: `impl-${n + 1}`, location });
      }
      await until("each is asked for", () => continued(d, from).length === 3);
      const ranYolo = (member: unknown) => typeof member === "object" && member !== null && Reflect.get(member, "yolo") === true;
      expect(continued(d, from).map((intent) => intent.kind === "continue" && { how: intent.how, landing: intent.landing, yolo: ranYolo(intent.member) })).toEqual([
        { how: "fork", landing: { kind: "team", team: teamId }, yolo: true },
        { how: "fork", landing: { kind: "team", team: teamId }, yolo: false },
        { how: "fork", landing: { kind: "team", team: teamId }, yolo: false },
      ]);
    });

    it("says a refused resume through the resume's notice, and a refused fork through the fork's own", async () => {
      const d = await open();
      await d.agentUp();
      const { flow, failures } = await dialogOn(d);
      // Its lead is the one lead the team has: each is refused.
      await startFrom(d, flow, "resume", { role: "lead" });
      await until("the resume's refusal is said", () => failures.length === 1);
      await startFrom(d, flow, "fork", { role: "lead" });
      await until("the fork's refusal is said", () => failures.length === 2);
      expect(failures).toEqual([expect.stringMatching(/^resume: .+/), expect.stringMatching(/^fork: .+/)]);
    });
  });

  describe("who holds a session", () => {
    it("reads the panes' bindings: a running one, a suspended one, none, another agent's", async () => {
      const d = await open();
      const { ws, paneId, session } = await d.agentUp();
      const other = await d.memberUp(teamOf(d), "reviewer");
      const dormant = d.pane(other).session?.id;
      if (!dormant) throw new Error("the reviewer bound nothing");
      expect(await d.runtime.orchestrator.suspend(ws.id, other)).toEqual({ kind: "suspending" });
      await until("suspended", () => d.phase(other) === "suspended" && d.settled() && d.slot(other) === "none");
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId: teamOf(d) }));
      expect(flow().sessionClaim({ agent: "stub", sessionId: session })).toBe("running");
      expect(flow().sessionClaim({ agent: "stub", sessionId: dormant })).toBe("stopped");
      expect(flow().sessionClaim({ agent: "stub", sessionId: "s-free" })).toBeNull();
      // Another CLI's session of the same id is no stub pane's.
      expect(flow().sessionClaim({ agent: "codex", sessionId: session })).toBeNull();
      expect(paneId).not.toBe(other);
    });

    it("calls a pane stuck on a folder that is gone stopped, and one merely on its way up running", async () => {
      // An agent in a worktree of its team's own, and a second in the root.
      const { stuck, rising } = await quitAfter(
        host(),
        async (d) => {
          d.gitRepo();
          const root = await d.agentUp();
          const elsewhere = await d.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } });
          await d.upAndBound(elsewhere);
          const cwd = d.launches(elsewhere)[0]?.cwd;
          if (!cwd) throw new Error("no worktree");
          return { stuck: { paneId: elsewhere, session: d.pane(elsewhere).session?.id ?? "", cwd }, rising: root };
        },
        (onDisk, made) => onDisk.includes(made.stuck.session) && onDisk.includes(made.rising.session),
        // While the app is down, the worktree goes.
        (made) => rmSync(made.stuck.cwd, { recursive: true, force: true }),
      );
      // The next launch's resumes are held at the spawn: each pane is on its
      // way up; the one whose folder is gone stays there.
      const opening = host().hold({ request: "pty_open" });
      const d = (deck = await startDeck(host()));
      const { flow } = await dialogOn(d);
      await until("the gone folder is seen", () => stuck.paneId in d.runtime.orchestrator.getView().blocked);
      expect(flow().sessionClaim({ agent: "stub", sessionId: stuck.session })).toBe("stopped");
      expect(flow().sessionClaim({ agent: "stub", sessionId: rising.session })).toBe("running");
      opening.release();
    });
  });

  describe("who the dialog opens for", () => {
    const teamOpen = (d: Deck) => d.runtime.deckStore.getSnapshot().viewByWs[d.workspace().id]?.teamOpen;

    it("opens a card's Fork as the member dialog, its bound session picked on its agent, the role left to choose", async () => {
      const d = await open();
      const { paneId, session } = await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      await act(async () => flow().forkPaneSession(d.workspace().id, paneId));
      expect(flow().dialog).toMatchObject({
        target: { kind: "member", teamId },
        defaultAgentType: "stub",
        preset: { mode: "fork", handle: { agent: "stub", sessionId: session, cwd: host().work } },
      });
      expect(flow().dialog?.roles.addressFor("lead")).toBeNull();
    });

    it("opens a Fork carrying how its source pane ran: the toggle starts there, not at the global default", async () => {
      const d = await open({ yolo: true });
      await d.workspaceUp();
      const lead = await d.addAgent({ role: "lead", yolo: true });
      await d.upAndBound(lead);
      const reviewer = await d.memberUp(teamOf(d), "reviewer");
      const { flow } = await dialogOn(d);
      const opensOn = () => {
        const dialog = flow().dialog;
        if (!dialog?.preset) throw new Error("no fork dialog");
        expect(dialog.defaultYolo).toBe(false);
        return presetPick(dialog.preset).ranYolo;
      };
      await act(async () => flow().forkPaneSession(d.workspace().id, lead));
      expect(opensOn()).toBe(true);
      act(() => flow().cancel());
      await act(async () => flow().forkPaneSession(d.workspace().id, reviewer));
      expect(opensOn()).toBe(false);
    });

    it("opens for a member with nothing to ask about where, lands it on the team under the role picked, and does not enter the team", async () => {
      const d = await open();
      await d.agentUp();
      const teamId = teamOf(d);
      const teamName = d.workspace().teams?.[0]?.name;
      const { flow } = await dialogOn(d);
      const stage = teamOpen(d);
      const from = host().tape.length;
      const asked = d.intents().length;
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
      // No repo inspection, no suggestion: a member runs where its team runs.
      expect(callsOf(host(), "worktree_inspect", from)).toEqual([]);
      expect(flow().dialog).toMatchObject({ target: { kind: "member", teamId, teamName, cwd: host().work }, repo: null, suggestedPath: "" });
      // The picker knows the roster the team holds.
      expect(flow().dialog?.roles.addressFor("lead")).toBeNull();
      expect(flow().dialog?.roles.addressFor("impl")).toBe("impl-1");
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo: false, role: "impl-1" });
      });
      await until("it is seated", () => d.intents().length > asked);
      expect(d.intents().slice(asked)).toEqual([expect.objectContaining({ kind: "seat", team: teamId, member: expect.objectContaining({ role: "impl-1" }) })]);
      // Joining a team is not entering it.
      expect(teamOpen(d)).toBe(stage);
    });

    it("opens no dialog for a member of a team that is gone, and offers no directory for one still being made", async () => {
      const d = await open();
      d.gitRepo();
      await d.agentUp();
      const { flow } = await dialogOn(d);
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId: "team-gone" }));
      expect(flow().dialog).toBeNull();
      // A team whose worktree is still being made: its settling is held.
      const settling = host().hold({ heard: '"kind":"settleTeam"' });
      const made = d.teamUp("web", { kind: "new", place: null, base: null });
      await until("the team stands, still being made", () => (d.workspace().teams ?? []).some((team) => team.name === "web"));
      const web = d.workspace().teams?.find((team) => team.name === "web")?.id;
      if (!web) throw new Error("no team web");
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId: web }));
      expect(flow().dialog).toMatchObject({ target: { kind: "member", teamId: web, cwd: null } });
      settling.release();
      await made;
      await until("the team settles in its worktree", () => d.workspace().teams?.find((team) => team.id === web)?.location?.kind === "attached");
    });

    it("opens no dialog for a workspace that closed while its repo was being looked at", async () => {
      const d = await open();
      d.gitRepo();
      const { ws } = await d.agentUp();
      const { flow } = await dialogOn(d);
      const looking = host().hold({ reply: "worktree_inspect" });
      let opening: Promise<void> = Promise.resolve();
      await act(async () => {
        opening = flow().openFor(d.workspace());
        await looking.caught;
      });
      const consent = await d.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } });
      expect((await d.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent })).kind).toBe("accepted");
      await until("the workspace is gone", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0);
      await act(async () => {
        looking.release();
        await opening;
      });
      expect(flow().dialog).toBeNull();
    });
  });

  describe("a new team", () => {
    const teamOpen = (d: Deck) => d.runtime.deckStore.getSnapshot().viewByWs[d.workspace().id]?.teamOpen;
    /** "+ Team" confirmed with `over` on its form. */
    const plusTeam = async (flow: () => Flow, d: Deck, over: Partial<Parameters<Flow["confirm"]>[0]>) => {
      await act(async () => flow().openFor(d.workspace()));
      const team = flow().dialog;
      if (!team) throw new Error("no team dialog");
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "", location: { kind: "new", path: team.suggestedPath, branch: team.suggestedBranch }, yolo: false, ...over });
      });
      return team;
    };

    it("is named the deck's next auto name, is made with nothing on it, and is entered", async () => {
      const d = await open();
      d.gitRepo();
      await d.agentUp();
      const names = (d.workspace().teams ?? []).map((team) => team.name);
      const { flow } = await dialogOn(d);
      const asked = d.intents().length;
      const team = await plusTeam(flow, d, { teamName: "docs" });
      expect(team.target).toMatchObject({ kind: "new-team", suggestedName: expect.stringMatching(/\S/) });
      if (team.target.kind === "new-team") expect(names).not.toContain(team.target.suggestedName);
      await until("the team stands", () => (d.workspace().teams ?? []).some((made) => made.name === "docs"));
      expect(d.intents().slice(asked)).toEqual([
        expect.objectContaining({ kind: "createTeam", draft: { name: "docs" }, site: { kind: "new", place: { path: team.suggestedPath, branch: team.suggestedBranch }, base: null }, members: [] }),
      ]);
      const docs = d.workspace().teams?.find((made) => made.name === "docs")?.id;
      await until("it is entered", () => teamOpen(d) === docs);
    });

    it("says so when the name is taken, and when the machine refuses the place, and enters nothing", async () => {
      const d = await open();
      d.gitRepo();
      await d.agentUp();
      const taken = d.workspace().teams?.[0]?.name ?? "";
      const { flow, failures } = await dialogOn(d);
      const before = teamOpen(d);
      await plusTeam(flow, d, { teamName: taken });
      await until("the taken name is said", () => failures.length === 1);
      expect(failures[0]).toContain(`“${taken}” already exists`);
      expect(teamOpen(d)).toBe(before);
      // A worktree another team already stands in: its place is held.
      const docs = await plusTeam(flow, d, { teamName: "docs" });
      const docsId = () => d.workspace().teams?.find((made) => made.name === "docs")?.id;
      await until("docs stands, entered", () => docsId() !== undefined && teamOpen(d) === docsId());
      await plusTeam(flow, d, { teamName: "web", location: { kind: "new", path: docs.suggestedPath, branch: "kd/web" } });
      await until("the held place is said", () => failures.length === 2);
      expect(failures[1]).toMatch(/^team: .+/);
      expect((d.workspace().teams ?? []).some((made) => made.name === "web")).toBe(false);
      expect(teamOpen(d)).toBe(docsId());
    });

    it("asks instead of failing when the folder is another team's, and makes the team on the answer", async () => {
      const d = await open();
      await d.agentUp();
      const holder = d.workspace().teams?.[0];
      if (!holder) throw new Error("no team");
      const { flow, failures } = await dialogOn(d);
      const asked = d.intents().length;
      await plusTeam(flow, d, { teamName: "docs", location: { kind: "existing", path: host().work, branch: "main" } });
      await until("the question is asked", () => flow().sharedAsk !== null);
      // Not a failure: nobody has been asked yet, and nothing was made.
      expect(failures).toEqual([]);
      expect(flow().sharedAsk).toMatchObject({ path: host().work, holder: { teamId: holder.id, teamName: holder.name } });
      expect(flow().dialog).toBeNull();
      expect(d.intents().slice(asked).some((intent) => intent.kind === "createTeam")).toBe(false);
      await act(async () => flow().sharedAsk?.confirm());
      await until("the team stands", () => (d.workspace().teams ?? []).some((made) => made.name === "docs"));
      expect(d.intents().slice(asked)).toEqual([expect.objectContaining({ kind: "createTeam", draft: { name: "docs" }, site: { kind: "existing", cwd: host().work } })]);
      expect(flow().sharedAsk).toBeNull();
      await until("it is entered", () => teamOpen(d) === d.workspace().teams?.find((made) => made.name === "docs")?.id);
    });

    it("drops the create when that question is cancelled", async () => {
      const d = await open();
      await d.agentUp();
      const { flow } = await dialogOn(d);
      const stage = teamOpen(d);
      const asked = d.intents().length;
      await plusTeam(flow, d, { teamName: "docs", location: { kind: "existing", path: host().work, branch: "main" } });
      await until("the question is asked", () => flow().sharedAsk !== null);
      act(() => flow().sharedAsk?.cancel());
      expect(flow().sharedAsk).toBeNull();
      // Long enough for a create to have gone out, had one been asked.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(d.intents().slice(asked)).toEqual([]);
      expect((d.workspace().teams ?? []).some((made) => made.name === "docs")).toBe(false);
      expect(teamOpen(d)).toBe(stage);
    });
  });

  describe("what lands on the pane", () => {
    it("lands the YOLO choice on the member — sparsely, only when armed", async () => {
      const d = await open({ yolo: true });
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      /** The member a confirm landed, and the pane the page asked the
       * machine to seat for it. */
      const confirmed = async (yolo: boolean, role: string) => {
        const before = d.workspace().panes.map((pane) => pane.id);
        const asked = d.intents().length;
        await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
        await act(async () => {
          flow().confirm({ agentType: "stub", name: "", location: { kind: "main" }, yolo, role });
        });
        await until("the member lands", () => newPanes(d, before).length === 1);
        const seated = d.intents().slice(asked).find((intent) => intent.kind === "seat");
        return { pane: newPanes(d, before)[0], draft: seated?.kind === "seat" ? seated.member : undefined };
      };
      const on = await confirmed(true, "impl-1");
      expect(on.pane?.yolo).toBe(true);
      expect(on.draft).toMatchObject({ yolo: true });
      // Off never goes as an explicit false: the pane asked for stays sparse.
      const off = await confirmed(false, "impl-2");
      expect(off.draft).not.toHaveProperty("yolo");
      expect(off.pane).not.toHaveProperty("yolo");
    });

    it("lands a remote member as a bare pane carrying its endpoint, on the team it joins, asking no folder", async () => {
      const d = await open();
      await d.agentUp();
      const teamId = teamOf(d);
      const { flow } = await dialogOn(d);
      const before = d.workspace().panes.map((pane) => pane.id);
      const asked = d.intents().length;
      await act(async () => flow().openFor(d.workspace(), { kind: "member", teamId }));
      await act(async () => {
        flow().confirm({ agentType: "stub", name: "vps agent", location: { kind: "main" }, yolo: false, role: "impl-1", remoteEndpoint: "ws://127.0.0.1:9" });
      });
      await until("the member lands", () => newPanes(d, before).length === 1);
      expect(newPanes(d, before)[0]).toMatchObject({ agentType: "stub", location: { kind: "remote", endpoint: "ws://127.0.0.1:9" }, team: { teamId } });
      expect(d.intents().slice(asked).some((intent) => "site" in intent)).toBe(false);
    });
  });
});
