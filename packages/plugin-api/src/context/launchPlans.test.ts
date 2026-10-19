import { describe, expect, it, vi } from "vitest";
import { launchPlans, type LaunchAdapter } from "./launchPlans";
import type { ForkPlanInput, ResumePlanInput, SpawnPlanInput, SpawnPlanOutput } from "./agents";

const input = { paneId: "p", workspace: { id: "w", instance: "i" }, cwd: "/repo" } as SpawnPlanInput;
const output = (): SpawnPlanOutput => ({ command: "cli", args: [], env: [] });

/** An adapter whose stage carries `--common` and settles the launch when told. */
function adapter(settled = false): LaunchAdapter & { fork: ReturnType<typeof vi.fn> } {
  return {
    stage: (_input, out) => {
      out.args.push("--common");
      return settled;
    },
    resume: (i) => ["--resume", i.sessionId],
    fork: vi.fn(async (i: ForkPlanInput) => ["--fork", i.sessionId]),
  };
}

describe("launchPlans", () => {
  it("carries the common part on every launch, then names the session", async () => {
    const plans = launchPlans(adapter());
    const spawn = output();
    await plans["spawn.plan"](input, spawn);
    expect(spawn.args).toEqual(["--common"]);

    const resume = output();
    await plans["resume.plan"]({ ...input, sessionId: "s1" } as ResumePlanInput, resume);
    expect(resume.args).toEqual(["--common", "--resume", "s1"]);

    const fork = output();
    await plans["fork.plan"]({ ...input, sessionId: "s1" } as ForkPlanInput, fork);
    expect(fork.args).toEqual(["--common", "--fork", "s1"]);
  });

  it("names no session and runs no fork surgery once the stage settled the launch", async () => {
    // A remote attach replaces the whole invocation: continuity is the
    // server's, and a store surgery here would touch a store nobody opens.
    const settled = adapter(true);
    const plans = launchPlans(settled);
    const resume = output();
    await plans["resume.plan"]({ ...input, sessionId: "s1" } as ResumePlanInput, resume);
    expect(resume.args).toEqual(["--common"]);
    const fork = output();
    await plans["fork.plan"]({ ...input, sessionId: "s1" } as ForkPlanInput, fork);
    expect(fork.args).toEqual(["--common"]);
    expect(settled.fork).not.toHaveBeenCalled();
  });

  it("lets a failed fork surgery reject the plan", async () => {
    const failing = { ...adapter(), fork: vi.fn(async () => { throw new Error("disk full"); }) };
    await expect(
      launchPlans(failing)["fork.plan"]({ ...input, sessionId: "s1" } as ForkPlanInput, output()),
    ).rejects.toThrow("disk full");
  });
});
