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

  it("hands the host what a fork's surgery needs only for its start", async () => {
    const scaffolded = {
      ...adapter(),
      fork: vi.fn(async () => ({
        args: ["--fork", "s1"],
        discard: { onceStarted: ["/store/T.jsonl"], ifNeverStarted: ["/store/T.jsonl", "/store/F"] },
      })),
    };
    const fork = output();
    await launchPlans(scaffolded)["fork.plan"]({ ...input, sessionId: "s1" } as ForkPlanInput, fork);
    expect(fork.args).toEqual(["--common", "--fork", "s1"]);
    expect(fork.discard).toEqual({
      onceStarted: ["/store/T.jsonl"],
      ifNeverStarted: ["/store/T.jsonl", "/store/F"],
    });
  });

  it("opens a recorded session with the environment its own reporter reads", async () => {
    // opencode 2.x runs its plugins in a child process that never sees `-s`;
    // only the environment reaches it, so the session is named there too.
    const named = { ...adapter(), resume: (i: ResumePlanInput) => ({ args: ["-s", i.sessionId], env: [["WHICH", i.sessionId]] as const }) };
    const resume = output();
    await launchPlans(named)["resume.plan"]({ ...input, sessionId: "s1" } as ResumePlanInput, resume);
    expect(resume.args).toEqual(["--common", "-s", "s1"]);
    expect(resume.env).toEqual([["WHICH", "s1"]]);
  });

  it("lets a failed fork surgery reject the plan", async () => {
    const failing = { ...adapter(), fork: vi.fn(async () => { throw new Error("disk full"); }) };
    await expect(
      launchPlans(failing)["fork.plan"]({ ...input, sessionId: "s1" } as ForkPlanInput, output()),
    ).rejects.toThrow("disk full");
  });
});
