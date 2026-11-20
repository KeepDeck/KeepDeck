import { beforeEach, describe, expect, it, vi } from "vitest";

const builders = vi.hoisted(() => ({
  buildResumeSpec: vi.fn(async (..._args: unknown[]) => true),
  buildForkSpec: vi.fn(async (..._args: unknown[]) => ({ plugin: "p", onceStarted: ["/s"], ifNeverStarted: ["/c"] })),
}));
vi.mock("../spawnSpecs", () => builders);

import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { SpawnPlanContext } from "../spawnSpecs/plans";
import { createContinuationPlans } from "./continuationPlans";

const W = { id: "ws-a", instance: createWorkspaceInstance() };
const SOURCE = { agent: "cli-a", session: "s-1" };
const ctx: SpawnPlanContext = { bridgeDir: "/b", bridgeUrl: "http://b", paneBridgeDir: async (pane) => `/b/${pane}` };

function plans(context: SpawnPlanContext | null = ctx) {
  return createContinuationPlans({
    plugins: { agents: () => [], installed: () => undefined, cliVersion: async () => null },
    spawnContext: { get: () => context, subscribe: () => () => {} },
    skillsAsk: () => async () => null,
    mcpAccess: async () => ({ entries: [] }),
    armCwd: async () => {},
  });
}

describe("createContinuationPlans", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds the resume the door noted, for the pane the machine minted, by the person's ask", async () => {
    const p = plans();
    p.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo", branch: "main", yolo: true });
    await p.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE });
    const [, agent, facts, , session, origin] = builders.buildResumeSpec.mock.calls[0];
    expect(agent).toBe("cli-a");
    expect(facts).toMatchObject({ paneId: "pane-9", workspace: W, cwd: "/repo", branch: "main", yolo: true });
    expect([session, origin]).toEqual(["s-1", "manual"]);
  });

  it("answers a fork's declared scaffolding, built in the folder the command names", async () => {
    const p = plans();
    p.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo", transcriptPath: "/t/s-1.jsonl" });
    expect(await p.buildFork({ workspace: "ws-a", pane: "pane-9", source: SOURCE, cwd: "/wt/kd-a-2" })).toEqual({
      plugin: "p",
      onceStarted: ["/s"],
      ifNeverStarted: ["/c"],
    });
    const [, , facts, , fork] = builders.buildForkSpec.mock.calls[0];
    expect(facts).toMatchObject({ paneId: "pane-9", cwd: "/wt/kd-a-2" });
    expect(fork).toEqual({ sessionId: "s-1", sourceCwd: "/repo", transcriptPath: "/t/s-1.jsonl" });
  });

  it("refuses a build nobody asked for, and one with no spawn context — never a plan from nothing", async () => {
    await expect(plans().buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE })).rejects.toThrow(/nothing was asked/);
    const early = plans(null);
    early.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo" });
    await expect(early.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE })).rejects.toThrow(/spawn context/);
  });

  it("a resume the agent could not plan is a failure, not a pane with no plan", async () => {
    builders.buildResumeSpec.mockResolvedValueOnce(false);
    const p = plans();
    p.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo" });
    await expect(p.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE })).rejects.toThrow(/could not prepare/);
  });
});
