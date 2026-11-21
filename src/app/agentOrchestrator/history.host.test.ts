// @vitest-environment happy-dom
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHandle } from "../../domain/journal";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import { useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";
import { STUB_AGENT } from "../../testing/host/stubPlugin";

/**
 * A recorded conversation continued into a new agent, end to end on the
 * app itself: what the page asks of the machine, what the plugin's hook is
 * asked to build, and the agent that rises — resumed in the conversation,
 * or forked into a new one copied from it.
 */
describe("a recorded conversation continued, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  const record = (over: Partial<SessionHandle> = {}): SessionHandle => ({ agent: STUB_AGENT, sessionId: "s-1", cwd: host().work, ...over });
  /** The one continue the page asked of the machine. */
  const continued = (d: Deck): Extract<Intent, { kind: "continue" }> => {
    const asked = d.intents().filter((intent): intent is Extract<Intent, { kind: "continue" }> => intent.kind === "continue");
    expect(asked).toHaveLength(1);
    return asked[0];
  };
  const minted = (outcome: Awaited<ReturnType<Deck["runtime"]["orchestrator"]["resumeSession"]>>) => {
    if (outcome.kind !== "accepted") throw new Error(`not taken: ${JSON.stringify(outcome)}`);
    const pane = outcome.minted.panes[0];
    if (!pane) throw new Error("no pane minted");
    return pane;
  };
  const folder = (name: string) => {
    const path = join(host().work, name);
    mkdirSync(path, { recursive: true });
    return path;
  };

  describe("a resume", () => {
    it("lands on the team working in the record's folder, under the role picked, and rises in the conversation", async () => {
      const d = await open();
      const { ws } = await d.agentUp();
      const team = d.workspace().teams?.[0]?.id;
      const pane = minted(await d.runtime.orchestrator.resumeSession(ws.id, record({ yolo: true }), { role: "reviewer-1", yolo: false }));
      // One intent, the member the machine is to make: the override is the
      // person's, and it reaches the member.
      expect(continued(d)).toEqual({
        kind: "continue",
        workspace: ws.id,
        landing: { kind: "team", team },
        source: { agent: STUB_AGENT, session: "s-1" },
        how: "resume",
        member: { agentType: STUB_AGENT, role: "reviewer-1", session: { id: "s-1" } },
      });
      expect(await d.upAndBound(pane)).toBe("s-1");
      expect(d.pane(pane).team).toEqual({ teamId: team, role: "reviewer-1" });
      expect(d.launches(pane)).toEqual([{ pane, args: expect.arrayContaining(["--resume", "s-1"]), cwd: host().work }]);
      const plan = d.stub.plans.find((asked) => asked.hook === "resume");
      expect(plan?.input).toMatchObject({ paneId: pane, cwd: host().work });
      expect(plan?.input.yolo ?? false).toBe(false);
    });

    it("lands on the team named by id, not the first one working in the same folder", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      const shared = folder("shared");
      await d.teamUp("api", { kind: "existing", cwd: shared });
      const web = await d.teamUp("web", { kind: "existing", cwd: shared });
      minted(await d.runtime.orchestrator.resumeSession(ws.id, record({ cwd: shared }), { team: web, role: "lead" }));
      expect(continued(d).landing).toEqual({ kind: "team", team: web });
    });

    it("makes a team at the record's folder when none works there — never under a name another team holds", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      await d.teamUp("api", { kind: "existing", cwd: folder("api") });
      const own = folder("own");
      const pane = minted(await d.runtime.orchestrator.resumeSession(ws.id, record({ cwd: own }), { name: "api", role: "lead" }));
      const landing = continued(d).landing;
      expect(landing).toMatchObject({ kind: "newTeam", site: { kind: "existing", cwd: own } });
      expect(landing.kind === "newTeam" && landing.draft).not.toEqual({ name: "api" });
      await d.upAndBound(pane);
      expect(d.launches(pane)[0]?.cwd).toBe(own);
    });

    it("fails a resume its agent could not plan, rather than raise an agent with no plan — or another conversation", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      d.stub.resumePlanFails = "the plugin cannot open s-1";
      const outcome = await d.runtime.orchestrator.resumeSession(ws.id, record(), { role: "lead" });
      // The plan is the machine's to ask for: its failure is the step's,
      // and the member never lands.
      await host().until("the continue is over", () => d.settled());
      expect(outcome.kind === "accepted" ? d.workspace().panes : []).toEqual([]);
      expect(host().tape.filter(({ line }) => line.includes('"cmd":"pty_open"'))).toEqual([]);
      expect(d.stub.plans.map((asked) => asked.hook)).toEqual(["resume"]);
    });

    it("resumes by the person's ask: a conversation its agent rejects is not quietly started over", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      d.stub.rejectResumes = 1;
      const pane = minted(await d.runtime.orchestrator.resumeSession(ws.id, record(), { role: "lead" }));
      await host().until("its agent rejected the conversation", () => d.launches(pane).length === 1 && d.slot(pane) === "exited", 15_000);
      // Heard as the window hears an exit: no recovery takes a resume the
      // person asked for — no retry, no fresh conversation in its place.
      expect(d.runtime.orchestrator.recoverRejectedResume(ws.id, pane, 1)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(d.launches(pane)).toHaveLength(1);
    });

    it("answers the machine's refusal, and the page writes nothing of its own", async () => {
      const d = await open();
      const { ws, session } = await d.agentUp();
      const before = { panes: d.workspace().panes, teams: d.workspace().teams };
      // The conversation runs in an agent already: the machine refuses a
      // second one into it.
      const outcome = await d.runtime.orchestrator.resumeSession(ws.id, record({ sessionId: session }), { role: "impl-1" });
      expect(outcome.kind).toBe("refused");
      expect({ panes: d.workspace().panes, teams: d.workspace().teams }).toEqual(before);
      // Nothing rose in it: the one process is the agent's own.
      expect(host().tape.filter(({ line }) => line.includes('"cmd":"pty_open"'))).toHaveLength(1);
    });
  });

  describe("a fork", () => {
    it("lands a member with no conversation yet at the chosen folder; the hook forks the record into it", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      const target = folder("elsewhere");
      const source = record({ cwd: folder("old"), transcriptPath: "/t/s-1.jsonl" });
      const pane = minted(await d.runtime.orchestrator.forkSession(ws.id, source, { kind: "dir", cwd: target }, { role: "lead" }));
      const intent = continued(d);
      expect(intent.how).toBe("fork");
      // The fork's new conversation arrives later, by its binding.
      expect(intent.member).toEqual({ agentType: STUB_AGENT, role: "lead" });
      expect(intent.landing).toMatchObject({ kind: "newTeam", site: { kind: "existing", cwd: target } });
      const conversation = await d.upAndBound(pane);
      expect(conversation).not.toBe("s-1");
      const plan = d.stub.plans.find((asked) => asked.hook === "fork");
      expect(plan?.input).toMatchObject({ paneId: pane, cwd: target, sessionId: "s-1", sourceCwd: source.cwd, transcriptPath: "/t/s-1.jsonl" });
      expect(d.launches(pane)[0]?.cwd).toBe(target);
      expect(host().tape.some(({ line }) => line.includes('"cmd":"lifecycle_hook_ended"'))).toBe(true);
      // The step answers the scaffolding the plugin declared — none, for
      // the stub — as data, under the plugin's name.
      const answered = host().tape.find(({ way, line }) => way === "page →" && line.includes('"kind":"forked"'));
      expect(answered?.line).toContain('"discard":{"plugin":"keepdeck.test-stub","onceStarted":[],"ifNeverStarted":[]}');
    });

    it("leaves the file out when nobody knows it — the plugin decides whether it needs one", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      const pane = minted(await d.runtime.orchestrator.forkSession(ws.id, record(), { kind: "dir", cwd: folder("elsewhere") }, { role: "lead" }));
      await d.upAndBound(pane);
      const plan = d.stub.plans.find((asked) => asked.hook === "fork");
      expect(plan && "transcriptPath" in plan.input).toBe(false);
    });

    it("into a new worktree: the machine is asked for it at the path, on the branch, from the base — and the hook runs once it stands", async () => {
      const d = await open();
      d.gitRepo();
      const ws = await d.workspaceUp();
      const path = join(host().trees, "fork-1");
      const pane = minted(await d.runtime.orchestrator.forkSession(ws.id, record({ yolo: true }), { kind: "worktree", path, branch: "fork/auth", base: "main" }, { role: "lead" }));
      const intent = continued(d);
      expect(intent.landing).toMatchObject({ kind: "newTeam", site: { kind: "new", place: { path, branch: "fork/auth" }, base: "main" } });
      expect(intent.member).toEqual({ agentType: STUB_AGENT, role: "lead", yolo: true });
      await d.upAndBound(pane);
      const plan = d.stub.plans.find((asked) => asked.hook === "fork");
      expect(plan).toMatchObject({ input: { cwd: path }, folderStood: true });
      expect(existsSync(path)).toBe(true);
    });

    it("lands on the team at the chosen folder under the role picked, and carries the YOLO override to the plan", async () => {
      const d = await open();
      const ws = await d.workspaceUp();
      const target = folder("elsewhere");
      const team = await d.teamUp("api", { kind: "existing", cwd: target });
      await d.upAndBound(await d.addAgent({ role: "lead", team }));
      const pane = minted(await d.runtime.orchestrator.forkSession(ws.id, record(), { kind: "dir", cwd: target }, { role: "reviewer-1", yolo: true }));
      expect(continued(d).landing).toEqual({ kind: "team", team });
      await d.upAndBound(pane);
      expect(d.pane(pane).team).toEqual({ teamId: team, role: "reviewer-1" });
      expect(d.pane(pane).yolo).toBe(true);
      expect(d.stub.plans.find((asked) => asked.hook === "fork")?.input).toMatchObject({ yolo: true });
    });
  });
});
