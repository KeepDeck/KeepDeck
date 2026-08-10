/**
 * Which way a pane is nudged into taking a turn.
 *
 * The nudge itself is one idea — "start a turn, your own channel will carry
 * the words" — and the mail owner states it once. What differs is only how it
 * reaches a process, and that is a fact about the CLI, not about the message:
 * a hook reporter cannot be called, so its pane is typed into; a reporter
 * living inside the agent can be told directly and never needs the terminal.
 *
 * Kept out of the owner deliberately. `mailManager` decides WHETHER a pane is
 * woken, from the clock and the rules; teaching it about agent plugins would
 * put a registry lookup in the middle of the one place in this feature that is
 * pure.
 */
import type { AgentStatus } from "@keepdeck/plugin-api";

export interface WakeChannelDeps {
  /** How this pane's agent is woken. Read PER CALL: a plugin can be enabled
   * or disabled while the deck is up, and a pane can be restarted onto
   * another agent. Absent (or no such pane) reads as the terminal — the
   * floor every CLI meets. */
  channelOf(paneId: string): AgentStatus["wake"] | undefined;
  /** Type the nudge into the pane. False means no live input channel at this
   * instant, which the owner treats as a retry. */
  throughTerminal(paneId: string): boolean;
  /** Ring the doorbell this agent's own reporter is watching. */
  throughBridge(paneId: string): void;
}

/**
 * The mail owner's `wake` port, resolved per pane.
 *
 * The bridge branch always answers TRUE, and that is not optimism dressed as
 * a result: there is nothing on this side to observe. A doorbell is a file;
 * whether a reporter is watching, whether the agent is between turns, whether
 * the plugin is even loaded — none of it is visible here, and a guess would
 * only add a second story to the one the mail already tells. A pane that
 * never comes to ask lets its message expire and the sender is told so, which
 * is the same ending a terminal nudge into a dead pane reaches.
 */
export function createMailWake(
  deps: WakeChannelDeps,
): (paneId: string) => boolean {
  return (paneId: string) => {
    if (deps.channelOf(paneId) !== "bridge") return deps.throughTerminal(paneId);
    deps.throughBridge(paneId);
    return true;
  };
}
