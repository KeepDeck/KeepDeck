import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { SpawnPlanContext } from "../spawnSpecs/plans";
import { createContinuationPlans } from "./continuationPlans";

// The plans a continued session builds run on the host now
// (history.host.test.ts): the resume for the pane the machine minted, the
// fork's scaffolding, a resume its agent could not plan. What stays is the
// guard that comes before any build — no real plugin is reached.
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
  it("refuses a build nobody asked for, and one with no spawn context — never a plan from nothing", async () => {
    await expect(plans().buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE })).rejects.toThrow(/nothing was asked/);
    const early = plans(null);
    early.expect("ws-a", SOURCE, { workspace: W, cwd: "/repo" });
    await expect(early.buildResume({ workspace: "ws-a", pane: "pane-9", source: SOURCE })).rejects.toThrow(/spawn context/);
  });
});
