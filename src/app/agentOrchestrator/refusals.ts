/**
 * A landing's refusal in words — ONE spelling for every door.
 *
 * Four doors used to translate the same outcome themselves: the command,
 * the dialog, the orchestrator's own throw and the start-fresh path. Three
 * agreed by copy, and the fourth had no `never` guard, so a refusal it had
 * not heard of would have reached the person as "that workspace was
 * closed". A refusal is said here or it is not said.
 */
import {
  placementRefusalMessage,
  TEAM_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
} from "../../domain/deck";
import { roleRefusalMessage } from "../../domain/mail";
import type { CreatePaneOutcome } from "./index";

/** Every way a landing ends other than with a pane on a team. */
export type CreateRefusal = Exclude<CreatePaneOutcome, { kind: "created" }>;

export function createRefusalMessage(refusal: CreateRefusal): string {
  switch (refusal.kind) {
    case "full":
      return TEAM_FULL_MESSAGE;
    case "gone":
      return WORKSPACE_GONE_MESSAGE;
    case "held":
      return placementRefusalMessage(refusal.why);
    case "role":
      return roleRefusalMessage(refusal.why, refusal.role);
    default: {
      const unhandled: never = refusal;
      throw new Error(`unhandled create outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}
