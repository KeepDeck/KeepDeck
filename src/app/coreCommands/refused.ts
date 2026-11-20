import type { IntentOutcome } from "../../domain/lifecycle";
import { intentOutcomeText } from "../../presentation/lifecycleWords";

/** What an intent the machine did not take says to the agent that asked —
 * the machine's refusal, or its silence, in the words the page uses. */
export function refusedBy(outcome: Exclude<IntentOutcome, { kind: "accepted" }>): Error {
  return new Error(intentOutcomeText(outcome) ?? "the lifecycle did not take it");
}
