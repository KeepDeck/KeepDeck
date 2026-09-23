import type { ResumeBlock } from "../domain/agents";
import { resumeBlock } from "../domain/deck";

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

/**
 * What a session row offers, from the facts about it. Neither action while
 * the journal filed it under the wrong agent — continuing it would feed the
 * wrong plugin. Resume is the domain's rule ([`resumeBlock`]); the row has
 * no outside-process probe (one per list costs a CLI spawn per agent), so a
 * busy session is refused at the landing rather than here.
 */
export function sessionRowActionsView(facts: {
  cwd: string;
  supportsResume: boolean;
  supportsFork: boolean;
  wrongOwner: boolean;
  live: boolean;
  dirPresent: boolean;
  team: { cwd: string | null } | null;
}): SessionRowActionsView {
  if (facts.wrongOwner) return { resume: null, fork: null };
  const block = resumeBlock(
    { cwd: facts.cwd, claimed: facts.live, busyOutside: false, dirPresent: facts.dirPresent },
    facts.team,
  );
  return {
    resume: facts.supportsResume ? { label: "Resume", ...resumeActionView(block, facts.cwd) } : null,
    fork: facts.supportsFork
      ? { label: "Fork", title: "Fork — a new conversation continuing from this session" }
      : null,
  };
}
