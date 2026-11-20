// @vitest-environment happy-dom
import { paneBranch, paneExecutionCwd } from "../../domain/deck";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Probe,
  agentRun,
  buildForkSpec,
  buildResumeSpec,
  catalog,
  createWorkspaceInstance,
  deck,
  gate,
  ipc,
  machine,
  peekPaneSpawnSpec,
  pty,
  resetPaneSpawnSpecs,
  settle,
  skillsAsked,
  transcripts,
} from "./testSupport";
import type { SessionHandle } from "./testSupport";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import { present } from "@keepdeck/plugin-api/testing";

/** One empty workspace to continue a session into. */
const emptyWorkspace = () =>
  act(() =>
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws-1",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
    }),
  );

const handle = (over: Partial<SessionHandle> = {}): SessionHandle =>
  ({
    agent: "codex",
    sessionId: "s-1",
    cwd: "/repo/wt",
    branch: "kd/x/1",
    yolo: true,
    // The plugin's fork hook needs the SOURCE transcript; without it a fork
    // lands in an empty conversation with a wrong usage baseline.
    transcriptPath: "/t/s-1.jsonl",
    ...over,
  }) as SessionHandle;

type Continue = Extract<Intent, { kind: "continue" }>;

/** The continue the machine was asked for — the one and only intent. */
function asked(): Continue {
  expect(machine.intents).toHaveLength(1);
  const intent = machine.intents[0];
  if (intent.kind !== "continue") throw new Error(`expected a continue, the machine was asked ${intent.kind}`);
  return intent;
}

const due = <O extends "deck" | "runState" | "forkStep">(owner: O, cmd: Cmd) => ({ id: { op: 7, index: 0 }, owner, cmd });

/** What the machine does with an accepted continue, as its commands reach
 * the page: the pane's plan first — the resume prepared, or the fork step
 * run in the folder it landed in — then the member onto the deck, on its
 * team or with the team made for it. Answers the fork step's outcome. */
async function machineContinues(cwd: string, pane = "pane-c"): Promise<Outcome | null> {
  const intent = asked();
  let step: Outcome | null = null;
  await act(async () => {
    const source = intent.source;
    if (intent.how === "resume") {
      await agentRun.runState.runState.carry(due("runState", { kind: "prepareResume", workspace: intent.workspace, pane, source }));
    } else {
      step = await agentRun.runState.forkStep.carry(due("forkStep", { kind: "fork", workspace: intent.workspace, pane, source, cwd }));
    }
    const carry = present(machine.carry, "the deck owner");
    const landing = intent.landing;
    const outcome =
      landing.kind === "team"
        ? await carry({ kind: "addPane", workspace: intent.workspace, team: landing.team, pane, draft: intent.member })
        : await carry({
            kind: "addTeam",
            workspace: intent.workspace,
            team: landing.team,
            draft: landing.draft,
            place: { kind: "attached", cwd, branch: null },
            members: [{ pane, draft: intent.member }],
          });
    expect(outcome.kind).toBe("applied");
  });
  await settle();
  return step;
}

const landed = (pane = "pane-c") => present(deck.workspaces[0].panes.find((candidate) => candidate.id === pane), pane);

describe("agent orchestrator —continuing a recorded session", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildResumeSpec).mockClear();
    vi.mocked(buildForkSpec).mockClear();
    transcripts.locateTranscript.mockClear();
    transcripts.indexed.clear();
    skillsAsked.mockClear();
    gate.build = null;
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
    emptyWorkspace();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  describe("a resume", () => {
    it("asks the machine to continue the record onto the team holding its folder, under the role picked", async () => {
      act(() => {
        deck.createTeam("ws-1", { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/wt" } });
        deck.addAgentPane("ws-1", { id: "p-lead", agentType: "claude" });
        deck.joinTeam("ws-1", "p-lead", "team-1", "lead");
      });

      await act(async () => {
        expect((await agentRun.resumeSession("ws-1", handle(), { role: "reviewer-1" })).kind).toBe("accepted");
      });

      // One intent and nothing written by the page: the pane is the
      // machine's to make.
      expect(asked()).toEqual({
        kind: "continue",
        workspace: "ws-1",
        landing: { kind: "team", team: "team-1" },
        source: { agent: "codex", session: "s-1" },
        how: "resume",
        member: { agentType: "codex", role: "reviewer-1", yolo: true, session: { id: "s-1" } },
      });
      expect(deck.workspaces[0].panes.map((pane) => pane.id)).toEqual(["p-lead"]);
    });

    it("lands on the team named by id, not the first one on the same folder", async () => {
      act(() => {
        deck.createTeam("ws-1", { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/wt" } });
        deck.createTeam("ws-1", { id: "team-2", name: "web", location: { kind: "attached", cwd: "/repo/wt" } });
      });
      await act(async () => {
        await agentRun.resumeSession("ws-1", handle(), { team: "team-2", role: "lead" });
      });
      expect(asked().landing).toEqual({ kind: "team", team: "team-2" });
    });

    it("makes a team at the session's folder when none holds it — never under a name another team holds", async () => {
      act(() => {
        deck.createTeam("ws-1", { id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/api" } });
      });
      await act(async () => {
        await agentRun.resumeSession("ws-1", handle(), { name: "api", role: "lead" });
      });
      expect(asked().landing).toEqual({
        kind: "newTeam",
        team: expect.stringMatching(/^team-[0-9a-f]{8}$/),
        site: { kind: "existing", cwd: "/repo/wt" },
        draft: { name: "Team 2" },
      });
    });

    it("builds the plan the machine asks for from the record, and the pane it lands rises on it", async () => {
      await act(async () => {
        await agentRun.resumeSession("ws-1", handle({ yolo: true }), { yolo: false, role: "lead" });
      });
      // The override is the person's: it reaches the member and the plan.
      expect(asked().member).toEqual({ agentType: "codex", role: "lead", session: { id: "s-1" } });

      await machineContinues("/repo/wt");

      const facts = vi.mocked(buildResumeSpec).mock.calls[0][2];
      expect(facts).toMatchObject({ paneId: "pane-c", cwd: "/repo/wt", branch: "kd/x/1", yolo: false });
      await facts.stagedSkills?.();
      expect(skillsAsked).toHaveBeenCalledWith({ id: "ws-1", instance: deck.workspaces[0].instance });
      // A MANUAL resume: a continuation the person asked for must not
      // quietly become a different conversation.
      expect(peekPaneSpawnSpec("pane-c")).toMatchObject({ resumeOf: "s-1", resumeOrigin: "manual" });

      const ws = deck.workspaces[0];
      expect(landed().session).toMatchObject({ id: "s-1" });
      expect(paneExecutionCwd(ws, landed())).toBe("/repo/wt");
      expect(pty.acquired.map((launch) => launch.paneId)).toEqual(["pane-c"]);
    });

    it("answers the machine's refusal, and the page writes nothing of its own", async () => {
      machine.answer = { kind: "answered", answer: { kind: "refused", refusal: { kind: "locationHeld" } } };
      await act(async () => {
        expect(await agentRun.resumeSession("ws-1", handle(), { role: "lead" })).toEqual({
          kind: "refused",
          refusal: { kind: "locationHeld" },
        });
      });
      expect(deck.workspaces[0].panes).toEqual([]);
      expect(deck.workspaces[0].teams ?? []).toEqual([]);
      expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    });
  });

  describe("a fork", () => {
    const forked = (over: Partial<SessionHandle> = {}) => handle({ agent: "claude", cwd: "/old/wt", yolo: false, ...over });

    it("folder target: a member with no session, at the chosen folder; the step forks the record into it", async () => {
      await act(async () => {
        await agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/elsewhere" }, { role: "lead" });
      });
      const intent = asked();
      expect(intent.how).toBe("fork");
      // The fork's NEW session id arrives later, by the binding.
      expect(intent.member).toEqual({ agentType: "claude", role: "lead" });
      expect(intent.landing).toMatchObject({ kind: "newTeam", site: { kind: "existing", cwd: "/elsewhere" } });

      const step = await machineContinues("/elsewhere");

      // The scaffolding the plugin declared goes back to the machine as data.
      expect(step).toEqual({ kind: "forked", discard: { plugin: "p", onceStarted: [], ifNeverStarted: [] } });
      const call = vi.mocked(buildForkSpec).mock.calls[0];
      expect(call[2]).toMatchObject({ paneId: "pane-c", cwd: "/elsewhere" });
      // Exact, not a subset: an extra or renamed field in the fork request is
      // as much a defect as a missing one.
      expect(call[4]).toEqual({ sessionId: "s-1", sourceCwd: "/old/wt", transcriptPath: "/t/s-1.jsonl" });
      expect(machine.hookEnded).toHaveBeenCalledWith(7);
      expect(paneExecutionCwd(deck.workspaces[0], landed())).toBe("/elsewhere");
      expect(landed().session).toBeUndefined();
    });

    it.each([
      { case: "the journal's path is the fork's file; the index is not asked", journal: "/t/s-1.jsonl", index: "/index/s-1.jsonl", file: "/t/s-1.jsonl", asksIndex: false },
      { case: "a record the journal gave no path forks the file the index knows", journal: undefined, index: "/index/s-1.jsonl", file: "/index/s-1.jsonl", asksIndex: true },
      { case: "a path nobody knows is left out — the plugin decides whether it needs one", journal: undefined, index: undefined, file: undefined, asksIndex: true },
    ])("$case", async ({ journal, index, file, asksIndex }) => {
      if (index !== undefined) transcripts.indexed.set("claude:s-1", index);
      await act(async () => {
        await agentRun.forkSession("ws-1", forked({ transcriptPath: journal }), { kind: "dir", cwd: "/elsewhere" }, { role: "lead" });
      });
      await machineContinues("/elsewhere");
      expect(vi.mocked(buildForkSpec).mock.calls[0][4]).toEqual({
        sessionId: "s-1",
        sourceCwd: "/old/wt",
        ...(file !== undefined && { transcriptPath: file }),
      });
      expect(transcripts.locateTranscript).toHaveBeenCalledTimes(asksIndex ? 1 : 0);
    });

    it("worktree target: the machine is asked for a new worktree at the path, on the branch, from the base", async () => {
      await act(async () => {
        await agentRun.forkSession(
          "ws-1",
          forked({ yolo: true }),
          { kind: "worktree", path: "/repo-wt/fork-1", branch: "fork/auth", base: "main" },
          { role: "lead" },
        );
      });
      const intent = asked();
      expect(intent.landing).toMatchObject({
        kind: "newTeam",
        site: { kind: "new", place: { path: "/repo-wt/fork-1", branch: "fork/auth" }, base: "main" },
      });
      expect(intent.member).toEqual({ agentType: "claude", role: "lead", yolo: true });
      // No surgery up front: the worktree is not there yet, and the fork step
      // is the machine's to run once it is.
      expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();
    });

    it("lands on the team at the chosen folder under the role picked, and carries the YOLO override to the plan", async () => {
      act(() => {
        deck.createTeam("ws-1", { id: "team-1", name: "api", location: { kind: "attached", cwd: "/elsewhere" } });
        deck.addAgentPane("ws-1", { id: "p-lead", agentType: "claude" });
        deck.joinTeam("ws-1", "p-lead", "team-1", "lead");
      });
      await act(async () => {
        await agentRun.forkSession("ws-1", forked(), { kind: "dir", cwd: "/elsewhere" }, { role: "reviewer-1", yolo: true });
      });
      expect(asked().landing).toEqual({ kind: "team", team: "team-1" });

      await machineContinues("/elsewhere");

      expect(landed().team).toEqual({ teamId: "team-1", role: "reviewer-1" });
      expect(landed().yolo).toBe(true);
      expect(vi.mocked(buildForkSpec).mock.calls[0][2]).toMatchObject({ yolo: true });
      expect(paneBranch(deck.workspaces[0], landed())).toBeUndefined();
    });
  });
});
