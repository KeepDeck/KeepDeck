import type { ResumeBlock } from "../domain/agents";
import type { SessionOffer } from "../domain/deck";

/** Why a session cannot be resumed here, in the words every surface that
 * offers a resume uses — null when it can. */
export function resumeBlockReason(block: ResumeBlock): string | null {
  switch (block) {
    case "no-cwd":
      return "no recorded directory — fork instead";
    case "claimed":
      return "already in a pane";
    case "busy-outside":
      return "running in the background — fork a copy to continue here";
    case "dir-gone":
      return "directory is gone — fork instead";
    case "elsewhere":
      return "recorded in another directory — fork a copy into this team";
    case null:
      return null;
  }
}

export interface ResumeActionView {
  disabled: boolean;
  title: string;
}

/** A session row's Resume button: held back with its reason, or saying
 * where the session resumes. */
export function resumeActionView(block: ResumeBlock, cwd: string): ResumeActionView {
  const reason = resumeBlockReason(block);
  return reason === null ? { disabled: false, title: `Resume in ${cwd}` } : { disabled: true, title: reason };
}

/** Under a fork's list: which session the copy is made of — the picked one
 * may be off the page, as a card's own session opened here is. */
export function forkPickLine(handle: { title?: string; sessionId: string }): string {
  return `✓ Forks ${handle.title ?? handle.sessionId} into this team`;
}

/** A session row's actions — which it offers, and how each reads. */
export interface SessionRowActionsView {
  /** Null when the row offers no Resume at all. */
  resume: (ResumeActionView & { label: string }) | null;
  /** Null when the row offers no Fork. */
  fork: { label: string; title: string } | null;
}

/** The domain's [`SessionOffer`] for a row, in words. */
export function sessionRowActionsView(offer: SessionOffer, cwd: string): SessionRowActionsView {
  return {
    resume: offer.resume ? { label: "Resume", ...resumeActionView(offer.resume.block, cwd) } : null,
    fork: offer.fork ? { label: "Fork", title: "Fork — a new conversation continuing from this session" } : null,
  };
}
