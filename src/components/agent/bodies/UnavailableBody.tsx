/**
 * The card a pane wears when nothing can run its agent.
 *
 * The pane keeps its identity and its session binding; the revive effect
 * skips it, and fixing the cause brings it back live rather than making a
 * different conversation.
 */
import type { UnavailableAgent } from "../unavailableAgent";

/**
 * One sentence, used as both the line and its tooltip.
 *
 * It wears `.pane__card-path`, so it ellipsizes inside the tile — and what
 * gets cut is the TAIL, which is the half that says what to do about it.
 * Naming the agent there instead left the instruction unrecoverable.
 */
export function unavailableAgentSentence(agent: UnavailableAgent): string {
  return agent.kind === "bin-missing"
    ? `${agent.reason} — install it, then re-enable the plugin in Settings → Plugins`
    : `No plugin provides “${agent.agent}” — enable it in Settings → Plugins`;
}

export function UnavailableBody({ agent }: { agent: UnavailableAgent }) {
  const sentence = unavailableAgentSentence(agent);
  return (
    <div className="pane__card" role="alert">
      <span className="pane__exit-title">Agent unavailable</span>
      <span className="pane__exit-sub pane__card-path" title={sentence}>
        {sentence}
      </span>
    </div>
  );
}
