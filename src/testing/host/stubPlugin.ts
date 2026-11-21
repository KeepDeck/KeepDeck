// The test plugin the page runs with on the host: a plugin like any other —
// a manifest, an agent registered on activation, plans built by its hooks —
// whose agent is the stub program (stubAgent.mjs). So the page's spawn plans
// are built for real, the bridge armed by the real plan builder, and nothing
// depends on the CLIs this machine happens to have.
import { existsSync } from "node:fs";
import { API_VERSION, type ForkPlanInput, type KeepDeckPlugin, type PluginManifest, type SpawnPlanInput, type SpawnPlanOutput } from "@keepdeck/plugin-api";
import { inject } from "vitest";
import type { PluginInstall } from "../../plugins/host/host";

/** The agent type a host test's panes run. */
export const STUB_AGENT = "stub";

/** One plan a hook of the stub plugin was asked for, as the page asked it —
 * and whether the folder it is for stood when it was asked. */
export type StubPlan =
  | { hook: "spawn" | "resume"; input: SpawnPlanInput; folderStood: boolean }
  | { hook: "fork"; input: ForkPlanInput; folderStood: boolean };

/** What a test tells the stub agent's plans, read at each plan — and what
 * the plans were asked. */
export interface StubAgentControl {
  /** Every plan asked of the stub plugin's hooks, in order. */
  plans: StubPlan[];
  /** Resumes are refused: the agent exits at once, having reported nothing. */
  rejectResumes: boolean;
  /** Forks are refused the same way: the fork never finishes. */
  rejectForks: boolean;
  /** A resume's plan cannot be built: its hook throws this, said as the
   * reason. */
  resumePlanFails: string | null;
  /** The agent ignores a polite stop: only the kill ends it. */
  deaf: boolean;
}

/** The stub plugin, as the plugin manager installs a built-in. */
export function stubPlugin(control: StubAgentControl): PluginInstall {
  const program = inject("stubAgent");
  const manifest: PluginManifest = {
    id: "keepdeck.test-stub",
    name: "Stub agent",
    version: "1.0.0",
    minApiVersion: API_VERSION,
    category: "cli",
    description: "The agent of the page's tests on the host harness.",
    // An agent's bin is run only under an exec capability that names it.
    capabilities: [{ kind: "exec", commands: ["node"] }],
    contributes: {
      agents: [
        {
          id: STUB_AGENT,
          label: "Stub",
          bin: "node",
          features: [
            { id: "session.new", label: "New sessions", group: "sessions" },
            { id: "session.resume", label: "Resume saved sessions", group: "sessions" },
            { id: "session.fork", label: "Fork saved sessions", group: "sessions" },
          ],
        },
      ],
    },
  };
  const run = (output: SpawnPlanOutput, args: string[]) => {
    output.command = process.execPath;
    output.args = [program, ...args, ...(control.deaf ? ["--deaf"] : [])];
  };
  const plugin: KeepDeckPlugin = {
    activate(ctx) {
      ctx.agents.register({
        id: STUB_AGENT,
        label: "Stub",
        detect: { bin: "node" },
        hooks: {
          "spawn.plan"(input, output) {
            control.plans.push({ hook: "spawn", input, folderStood: existsSync(input.cwd) });
            run(output, []);
          },
          "resume.plan"(input, output) {
            control.plans.push({ hook: "resume", input, folderStood: existsSync(input.cwd) });
            if (control.resumePlanFails !== null) throw new Error(control.resumePlanFails);
            run(output, ["--resume", input.sessionId, ...(control.rejectResumes ? ["--reject"] : [])]);
          },
          // Its store is its own process: the fork copies nothing, so it
          // leaves nothing to take back.
          "fork.plan"(input, output) {
            control.plans.push({ hook: "fork", input, folderStood: existsSync(input.cwd) });
            run(output, ["--fork", input.sessionId, ...(control.rejectForks ? ["--reject"] : [])]);
          },
        },
      });
    },
  };
  return { manifest, load: () => Promise.resolve(plugin) };
}
