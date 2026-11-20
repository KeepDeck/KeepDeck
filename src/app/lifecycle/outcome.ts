/**
 * An intent's reply, as the page reasons with it. The machine answers an
 * intent with an acceptance or a refusal; a silence is the door's own. Any
 * other answer to an intent — a lease, an admission, a boot — is a broken
 * contract between the page and the machine, said loudly rather than
 * mistaken for either.
 */
import type { IntentOutcome } from "../../domain/lifecycle";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";

export function intentOutcomeOf(reply: Reply): IntentOutcome {
  if (reply.kind !== "answered") return { kind: "unanswered", reply };
  const answer = reply.answer;
  switch (answer.kind) {
    case "accepted":
      return { kind: "accepted", op: answer.op, minted: answer.minted };
    case "refused":
      return { kind: "refused", refusal: answer.refusal };
    default:
      throw new Error(`the lifecycle answered an intent with "${answer.kind}"`);
  }
}
