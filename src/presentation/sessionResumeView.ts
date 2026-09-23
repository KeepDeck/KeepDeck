import type { ResumeBlock } from "../domain/agents";

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
