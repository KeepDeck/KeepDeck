/**
 * How an agent's pane launches — spawn, resume and fork — written once.
 *
 * Every agent's three plan hooks are the same shape: everything a launch of
 * that CLI carries (skills, permission mode, injected MCP servers, its
 * reporters, a remote target), then, for a resume or a fork, the CLI's way
 * to name the session it opens — after the store surgery a fork needs. Each
 * plugin used to write that shape three times, and a carrier added to one
 * hook and forgotten in another is no visible mistake: that pane simply comes
 * up without it. The shape lives here; a plugin supplies its [`LaunchAdapter`].
 */
import type {
  AgentHooks,
  ForkDiscard,
  ForkPlanInput,
  ResumePlanInput,
  SpawnPlanInput,
  SpawnPlanOutput,
} from "./agents.ts";

/** One CLI's launch, in its own flags and env. */
export interface LaunchAdapter {
  /**
   * What EVERY launch of this CLI carries, pushed onto `output` (args, env,
   * env defaults). Answers `true` when it settled the launch whole — a
   * remote attach that replaces the invocation — so no session is named
   * after it and no fork surgery runs.
   */
  stage(
    input: SpawnPlanInput,
    output: SpawnPlanOutput,
  ): boolean | void | Promise<boolean | void>;
  /** What opens a recorded session: its arguments, or its arguments and
   * the environment that tells the agent's own reporter which session it is
   * — for a CLI whose reporter cannot read the arguments it was started with. */
  resume(input: ResumePlanInput): ResumeLaunch;
  /** The store surgery a fork needs, then the arguments that open the fork —
   * with what of that surgery only the start needs, when there is any.
   * Throwing must leave the store untouched. */
  fork(input: ForkPlanInput): ForkLaunch | Promise<ForkLaunch>;
}

/** How a recorded session opens: its arguments, or its arguments and the
 * environment that goes with them. */
export type ResumeLaunch =
  | readonly string[]
  | { args: readonly string[]; env?: readonly (readonly [string, string])[] };

/** How a fork opens: its arguments, or its arguments and the scaffolding
 * the host removes around its start ([`ForkDiscard`]). */
export type ForkLaunch =
  | readonly string[]
  | { args: readonly string[]; discard?: ForkDiscard };

function isArgs(launch: ForkLaunch | ResumeLaunch): launch is readonly string[] {
  return Array.isArray(launch);
}

/** The three plan hooks over one adapter. */
export function launchPlans(
  adapter: LaunchAdapter,
): Required<Pick<AgentHooks, "spawn.plan" | "resume.plan" | "fork.plan">> {
  return {
    "spawn.plan": async (input, output) => {
      await adapter.stage(input, output);
    },
    "resume.plan": async (input, output) => {
      if (await adapter.stage(input, output)) return;
      const launch = adapter.resume(input);
      if (isArgs(launch)) {
        output.args.push(...launch);
        return;
      }
      output.args.push(...launch.args);
      for (const [key, value] of launch.env ?? []) output.env.push([key, value]);
    },
    "fork.plan": async (input, output) => {
      if (await adapter.stage(input, output)) return;
      const launch = await adapter.fork(input);
      if (isArgs(launch)) {
        output.args.push(...launch);
        return;
      }
      output.args.push(...launch.args);
      if (launch.discard) output.discard = launch.discard;
    },
  };
}
