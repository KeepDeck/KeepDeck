/**
 * The words every door uses for the deck's own refusals of a team or a
 * pane — one place, so an agent driving `team.add` and a person pressing
 * "+ Member" are told the same thing. Why a place or a folder is held is the
 * lifecycle machine's to say (its refusals are worded in
 * presentation/lifecycleWords).
 */

/** Max agents ONE TEAM holds at once — the message, not the cap; the cap
 * itself lives with the grid it constrains. */
export function teamFullMessage(maxPanes: number): string {
  return `The team is full — ${maxPanes} agents; close one first`;
}

/** The error when the workspace a pane was headed for is no longer in the
 * deck — every add re-resolves against the live store, and a close can land
 * inside the awaits a worktree create or a fork's surgery needs. */
export const WORKSPACE_GONE_MESSAGE = "That workspace was closed.";

/** The error when a member is asked for while no agent is there to run it —
 * none installed or enabled. No agent is ever assumed in its place. */
export const NO_AGENT_MESSAGE = "No agent available — install or enable an agent plugin.";
