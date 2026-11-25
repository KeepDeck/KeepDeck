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
 * A launch can also keep its setup and still go unheard: when the deck has
 * no bridge for it to report through, the agent reaches its tools and its
 * skills, and nothing it says of itself — its status, its conversation, its
 * asks for mail — reaches the deck.
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
  | { cause: "command-refused"; pluginId: string; command: string }
  /** This run of the deck has no bridge — its door could not open — so no
   * launch of it can be heard until the deck starts again. */
  | { cause: "bridge-down" }
  /** The pane's own bridge directory could not be made, so this launch was
   * given no bridge. `error` is the failure's own words. */
  | { cause: "pane-dir-failed"; error: string };
