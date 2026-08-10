/** Why a pane's agent can't run — the card copy and the recovery gesture
 * differ per kind, so they are modeled as a union, not parallel optionals.
 *
 * Its own module because both the pane and the card that renders it need it,
 * and a type declared inside a component makes every other consumer import
 * the component. */
export type UnavailableAgent =
  /** No enabled plugin provides this agent (disabled or uninstalled). */
  | { kind: "no-plugin"; agent: string }
  /** A plugin provides it and is enabled, but the agent's CLI is not
   * installed on this machine; `reason` is the gate's sentence. */
  | { kind: "bin-missing"; agent: string; reason: string };
