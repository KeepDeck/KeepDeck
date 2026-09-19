import { leadRole } from "../../domain/mail";
import type { TaskProblem } from "./tasksService";

/**
 * A refusal, in the words the calling agent can act on. Facts about the
 * board and the one honest next step — never an instruction about what the
 * agent should have wanted. The ONE switch over the kinds; the domain
 * writes no English and the dialog renders the same kinds its own way.
 */
export function refusalText(refusal: TaskProblem): string {
  const lead = leadRole().id;
  switch (refusal.kind) {
    case "not-an-agent-on-a-team":
      return "you are on no team — a task lives on a team's board";
    case "not-on-team":
      return "that task is on another team's board — you read and write only your own team's";
    case "not-your-task":
      return refusal.assignee === null
        ? "that task is in the pool but not waiting in todo — it cannot be taken now"
        : `that task is ${refusal.assignee}'s — you move only your own; ask ${lead} to reassign it`;
    case "not-yours-to-assign":
      return `${refusal.field} is ${lead}'s to set on this team — you may create a task for yourself or the pool, or ask ${lead}`;
    case "review-not-yours":
      return `accepting, returning, reopening or cancelling a task is ${lead}'s — move yours to review and say so`;
    case "illegal-transition":
      return `a task cannot go from ${refusal.from} to ${refusal.to}`;
    case "blocked-by-open":
      return `still blocked by ${refusal.blockers.join(", ")} — they must be done or cancelled first`;
    case "already-claimed":
      return `that task is already ${refusal.assignee}'s`;
    case "claim-needs-an-agent":
      return "only an agent claims a task";
    case "assignee-not-on-team":
      return `no "${refusal.assignee}" on this team — an assignee is a role address from the team's roster`;
    case "unknown-blocker":
      return `no such task: ${refusal.ids.join(", ")}`;
    case "cross-team-blocker":
      return `${refusal.ids.join(", ")} is on another team's board — a blocker must be on the same board`;
    case "self-blocker":
      return "a task cannot block itself";
    case "cyclic-blocker":
      return `${refusal.ids.join(", ")} already waits on this task — that would be a cycle`;
    case "field-cap":
      return `${refusal.field} must be at most ${refusal.max} characters`;
    case "blank":
      return `${refusal.field} must not be blank`;
    case "board-full":
      return `this workspace's board holds ${refusal.max} tasks — finish or cancel some first`;
    case "board-unreadable":
      return `the board file could not be read and is not written to until fixed: ${refusal.error}`;
    case "unknown-task":
      return `no such task: ${refusal.id}`;
  }
}
