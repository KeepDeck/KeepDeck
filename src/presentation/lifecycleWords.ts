/**
 * What the lifecycle says when it does not do what was asked: one sentence
 * per refusal kind, and one for each way the waiting door comes back with no
 * answer. Rust hands over kinds and data, never English; every surface that
 * sends an intent says these words, so the same state reads the same
 * everywhere. Each kind has its own sentence — none is borrowed from a
 * neighbour that merely sounds close.
 */
import { TEAM_FULL_MESSAGE } from "../domain/deck";
import { ownerRefusalOf, type IntentOutcome, type NoAnswer, type OwnerRefusal, type Refusal, type Standing } from "../domain/lifecycle";
import { roleRefusalMessage } from "../domain/mail";
import { sessionHeldText } from "./resumeWords";

export function refusalText(refusal: Refusal): string {
  switch (refusal.kind) {
    case "alreadyClosing":
      return "It is already being closed.";
    case "busy":
      return "Something else is being done to it right now — try again once that has finished.";
    case "notFound":
      return "It is no longer there.";
    case "barrierUp":
      return "KeepDeck is still finishing what its last run left undone — try again in a moment.";
    case "journalUnavailable":
      return "KeepDeck could not write this down before starting it, so nothing was done.";
    case "journalStuck":
      return "KeepDeck could not write this down, nor take back what it wrote — it may still be done when KeepDeck next starts.";
    case "locationHeld":
      return "That place is taken — by a team, a creation, a cleanup not yet finished, or something already on disk.";
    case "targetLeaving":
      return "It is on its way out.";
    case "archived":
      return "Its workspace is archived.";
    case "sessionsDown":
      return "KeepDeck lost control of its sessions — nothing starts until it restarts.";
    case "forkStepExpired":
      return "The agent did not prepare the fork in time; nothing of it was kept.";
    case "planExpired":
      return "The agent did not prepare the resume in time, so the conversation was not resumed.";
    case "forkUnfinished":
      return "The fork did not finish, so nothing of it was kept.";
    case "changed":
      return "It changed while you were deciding — an agent joined it, or there is more to delete. Nothing was closed; look at it again.";
    case "rejected":
      return ownerRefusalText(ownerRefusalOf(refusal.why));
  }
}

/** An owner's refusal, said by its kind. */
export function ownerRefusalText(refusal: OwnerRefusal): string {
  switch (refusal.kind) {
    case "gone":
      return `That ${refusal.what} is gone.`;
    case "unreadable":
      return `The new ${refusal.what}'s details could not be read, so nothing was added.`;
    case "notTaken":
      return refusal.what === "move" ? "The deck did not take the move." : `The deck did not take the new ${refusal.what}.`;
    case "teamFull":
      return TEAM_FULL_MESSAGE;
    case "role":
      return roleRefusalMessage(refusal.why, refusal.role, refusal.open);
    case "sessionHeld":
      return sessionHeldText();
    case "noBranch":
      return "A team's worktree settles only on its own branch, and none was named.";
    case "wrongOwner":
      return "KeepDeck sent this to the wrong place, so nothing was done.";
    case "notAsked":
      return "Nothing in this run of KeepDeck asked to continue that conversation, so it was not carried on.";
    case "failed":
      return "It could not be done — KeepDeck's log says why.";
    case "unknown":
      return "It was refused.";
  }
}

/** The waiting door's word when the machine gave no answer. */
export function noAnswerText(reply: NoAnswer): string {
  switch (reply.kind) {
    case "unavailable":
      return "KeepDeck's lifecycle is not running, so nothing was done.";
    case "unknown":
      return "KeepDeck's lifecycle stopped before it answered — whether this was done shows once KeepDeck restarts.";
  }
}

/** Why an intent did not go ahead, in the words every surface says — null
 * for one the machine took on. */
export function intentOutcomeText(outcome: IntentOutcome): string | null {
  switch (outcome.kind) {
    case "accepted":
      return null;
    case "refused":
      return refusalText(outcome.refusal);
    case "unanswered":
      return noAnswerText(outcome.reply);
  }
}

/** What the lifecycle says once about KeepDeck's work as a whole. */
export function standingNotice(standing: Standing): { title: string; body: string } {
  switch (standing) {
    case "sessionsDown":
      return {
        title: "KeepDeck lost control of its sessions",
        body: "Nothing starts or closes here — not even a terminal — until KeepDeck restarts.",
      };
    case "stopped":
      return {
        title: "KeepDeck's lifecycle stopped",
        body: "Agents, teams and workspaces can no longer start or close — not even a terminal — until KeepDeck restarts.",
      };
  }
}
