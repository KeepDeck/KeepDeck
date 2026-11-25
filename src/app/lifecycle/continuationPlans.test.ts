import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { SpawnPlanContext } from "../spawnSpecs/plans";
import { createContinuationPlans } from "./continuationPlans";

// The plans a continued session builds run on the host (history.host.test.ts):
// the resume for the pane the machine minted, the fork's scaffolding, a resume
// its agent could not plan. Here is the owner's own rule — what each build is
// made from, and when there is none to make — with the plan builders it hands
// those facts to standing in for the plugins.
const builders = vi.hoisted(() => ({ fork: vi.fn(), resume: vi.fn() }));
vi.mock("../spawnSpecs", () => ({ buildForkSpec: builders.fork, buildResumeSpec: builders.resume }));

const W = { id: "ws-a", instance: createWorkspaceInstance() };
const SOURCE = { agent: "cli-a", session: "s-1" };
const DISCARD = { plugin: "cli-a", onceStarted: [], ifNeverStarted: [] };
const ctx: SpawnPlanContext = { bridgeDir: "/b", bridgeSocket: "/b/s", paneBridgeDir: async (pane) => `/b/${pane}` };
const asked = (role: string, yolo?: boolean) => ({ agentType: "cli-a", role, ...(yolo !== undefined && { yolo }) });

function plans(context: SpawnPlanContext | null = ctx) {
  return createContinuationPlans({
    plugins: { agents: () => [], installed: () => undefined, cliVersion: async () => null },
    spawnContext: { get: () => context, subscribe: () => () => {} },
    skillsAsk: () => async () => null,
    mcpAccess: async () => ({ entries: [] }),
    armCwd: async () => {},
  });
}

/** What each build was handed: its pane, its YOLO, and what it knew of the
 * conversation. */
const forks = () => builders.fork.mock.calls.map(([, , facts, , fork]) => ({ pane: facts.paneId, yolo: facts.yolo, transcript: fork.transcriptPath }));
const resumes = () => builders.resume.mock.calls.map(([, , facts]) => ({ pane: facts.paneId, yolo: facts.yolo, branch: facts.branch }));

describe("createContinuationPlans", () => {
  beforeEach(() => {
    builders.fork.mockReset().mockResolvedValue(DISCARD);
    builders.resume.mockReset().mockResolvedValue(true);
  });

  it("refuses, as its own kind, a build nobody in this run asked for — before it reads the draft", async () => {
    const owner = plans(null);
    expect(await owner.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE, draft: null })).toEqual({ kind: "refused", why: { kind: "notAsked" } });
    expect(await owner.buildFork({ workspace: "ws-a", pane: "pane-9", source: SOURCE, cwd: "/repo", draft: asked("lead") })).toEqual({
      kind: "refused",
      why: { kind: "notAsked" },
    });
    expect(builders.resume).not.toHaveBeenCalled();
    expect(builders.fork).not.toHaveBeenCalled();
  });

  it("refuses a draft it cannot read, and a build before the spawn context — never a plan from nothing", async () => {
    const owner = plans();
    owner.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo" });
    expect(await owner.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE, draft: { agentType: "cli-a" } })).toEqual({
      kind: "refused",
      why: { kind: "unreadable", what: "agent" },
    });
    const early = plans(null);
    early.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo" });
    await expect(early.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE, draft: asked("lead") })).rejects.toThrow(/spawn context/);
  });

  it("builds each continuation of one conversation from its own ask, and keeps what is known of the conversation for every one", async () => {
    const owner = plans();
    // A fork's note knows the transcript; a resume's, noted after it, does not.
    owner.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo", branch: "main", transcriptPath: "/t/s-1.jsonl" });
    owner.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo" });

    expect(await owner.buildFork({ workspace: "ws-a", pane: "pane-1", source: SOURCE, cwd: "/wt/1", draft: asked("impl-1") })).toEqual({ kind: "built", value: DISCARD });
    await owner.buildFork({ workspace: "ws-a", pane: "pane-2", source: SOURCE, cwd: "/wt/2", draft: asked("impl-2", true) });
    expect(await owner.buildResume({ workspace: "ws-a", pane: "pane-3", source: SOURCE, draft: asked("impl-3", true) })).toEqual({ kind: "built", value: null });
    // The machine's retry of a step finds the same facts.
    await owner.buildFork({ workspace: "ws-a", pane: "pane-1", source: SOURCE, cwd: "/wt/1", draft: asked("impl-1") });

    expect(forks()).toEqual([
      { pane: "pane-1", yolo: undefined, transcript: "/t/s-1.jsonl" },
      { pane: "pane-2", yolo: true, transcript: "/t/s-1.jsonl" },
      { pane: "pane-1", yolo: undefined, transcript: "/t/s-1.jsonl" },
    ]);
    expect(resumes()).toEqual([{ pane: "pane-3", yolo: true, branch: "main" }]);
  });
});
