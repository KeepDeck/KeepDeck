/**
 * Why a pane's agent runs WITHOUT KeepDeck's setup (task-572).
 *
 * A launch plan is what joins an agent to the deck: the reporter its hooks
 * load, the MCP servers it is given, the skills it can see. When the host
 * cannot use the plan its plugin built, it still starts the agent — a live
 * CLI beats a dead pane — but on the plugin's bare floor, and all three are
 * lost at once. The agent works; the deck cannot hear it, reach it, or
 * resume it. That is a fact about the pane, with a cause, and it lasts for
 * the life of the process: the next launch builds a new plan.
 *
 * Product vocabulary, not mechanism: a closed set of causes, worded by the
 * presentation (`unconnectedLaunchView`). The plan that carries it is the
 * builder's, in app/spawnSpecs/plans.ts.
 */
export type UnconnectedLaunch =
  /** The agent's plugin failed while building the plan. `error` is the
   * failure's own words. */
  | { cause: "plan-failed"; error: string }
  /** An external plugin's plan named a program its `exec` grant does not
   * cover, so the host ran the agent's own binary instead. */
  | { cause: "command-refused"; pluginId: string; command: string };
