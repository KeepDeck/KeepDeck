import type { StoreError } from "../../ipc/generated/tasks/StoreError";
import type { MigrationOutcome } from "./migration";
import type { Workspace } from "../../domain/deck";
import { leadRole } from "../../domain/mail";
import type { DecodeFault, NotCarried } from "../../domain/tasks";
import { blockerLinkWords } from "../../presentation/tasks/words";
import type { TaskProblem, UnsavedBoard } from "./tasksService";

/** Why an Off was refused: the boards the store would have closed over
 * unsaved, by the workspace's name where it has one. */
export function unsavedBoardsText(unsaved: readonly UnsavedBoard[], workspaces: readonly Workspace[]): string {
  return unsaved
    .map((board) => {
      const name = workspaces.find((workspace) => workspace.id === board.workspaceId)?.name ?? board.workspaceId;
      return `${name}'s board — ${board.error}`;
    })
    .join("; ");
}

/** Why a board file was refused, for the log and the dialog — the codec
 * names the fault, this names it in words. */
export function decodeFaultText(fault: DecodeFault, source = "board.json"): string {
  switch (fault.kind) {
    case "not-json":
      return `${source} is not JSON: ${fault.detail}`;
    case "not-object":
      return `${source} is not an object`;
    case "tasks-not-array":
      return `${source}: tasks must be an array`;
    case "bad-counter":
      return `${source}: nextId must be a safe integer of at least ${fault.atLeast}, above every task id`;
    case "bad-task":
      return `${source}: tasks[${fault.index}]${fault.id ? ` (${fault.id})` : ""}: ${fault.field} does not fit`;
    case "duplicate-id":
      return `${source}: duplicate task id ${fault.id}`;
    case "duplicate-uid":
      return `${source}: ${fault.id} has the uid of another task`;
    case "relations-not-array":
      return `${source}: relations must be an array`;
    case "bad-relation": {
      const end = (key: string | null) => key ?? "a task not on this board";
      return `${source}: relations[${fault.index}] (${end(fault.from)} → ${end(fault.to)}): ${fault.field} does not fit`;
    }
    case "unknown-field":
      return `${source}: a field this KeepDeck does not know — "${fault.field}"`;
  }
}

/** Why nothing can be written before the store is open. */
export const BOARD_NOT_OPEN = "the task board is not open";

/** Why nothing can be written after a move that did not make the database
 * the source. */
export function migrationRefusalText(outcome: Exclude<MigrationOutcome, { kind: "active" }>): string {
  if (outcome.kind === "failed") return `the boards could not move into the task database — ${outcome.reason}`;
  switch (outcome.status.kind) {
    case "damaged":
      return `the task database is damaged: ${outcome.status.detail}`;
    case "missing":
      return `the task database is missing, though ${outcome.status.detail}`;
    case "tooNew":
      return `a newer KeepDeck wrote the task database (${outcome.status.migration})`;
  }
}

/** A coded refusal from the task database, in words for the person —
 * and for the log line an unsaved board shows. */
export function storeErrorText(error: StoreError): string {
  switch (error.code) {
    case "off":
      return "the task board is off — turn Tasks on first";
    case "busy":
      return "another program has the task database open — try again once it lets go";
    case "diskFull":
      return "the disk is full";
    case "io":
      return `the disk refused: ${error.detail}`;
    case "constraint":
      return `the change does not fit the stored board: ${error.detail}`;
    case "conflict":
      return "the board changed in the database meanwhile — it was read again";
    case "inconsistent":
      return `board ${error.board} does not hold together in the task database: ${error.detail}`;
    case "corrupt":
      return `the task database is damaged: ${error.detail}`;
    case "missing":
      return `the task database is missing, though ${error.detail}`;
    case "schemaTooNew":
      return `a newer KeepDeck wrote the task database (${error.migration}) — this one only reads it`;
    case "invalid":
      return error.detail;
  }
}

/**
 * A refusal, in the words the calling agent can act on. Facts about the
 * board and the one honest next step — never an instruction about what the
 * agent should have wanted. The ONE switch over the kinds; the domain
 * writes no English and the dialog renders the same kinds its own way.
 */
/** What a copy left at its default, said to the agent that asked for it
 * (task.duplicate), or null when it carried everything. */
export function notCarriedText(left: readonly NotCarried[]): string | null {
  if (left.length === 0) return null;
  const said = left.map((item) =>
    item.field === "priority"
      ? `priority (${item.was}) — yours to set at creation is normal`
      : `labels (${item.was}) — a pool task's are the lead's to set`,
  );
  return `not carried over: ${said.join("; ")}`;
}

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
    case "illegal-transition": {
      const said = `a task cannot go from ${refusal.from} to ${refusal.to}`;
      if (refusal.reachable === undefined) return said;
      return refusal.reachable.length === 0
        ? `${said}, and from ${refusal.from} no move is yours`
        : `${said} — from ${refusal.from} it can go to ${refusal.reachable.join(", ")}`;
    }
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
      return `${refusal.field} is ${refusal.length} characters — at most ${refusal.max}; shorten it by ${refusal.length - refusal.max}`;
    case "blank":
      return `${refusal.field} must not be blank`;
    case "bad-label":
      return `"${refusal.label}" is not a label — one word of lowercase letters and digits, dashes between, at most ${refusal.max} characters`;
    case "not-yours-to-label":
      return refusal.assignee === null
        ? `that task is in the pool — its labels are ${lead}'s to set until somebody holds it`
        : `that task is ${refusal.assignee}'s — its labels are theirs and ${lead}'s`;
    case "bad-create-status":
      return `a task is created in ${refusal.allowed.join(" or ")}, not "${refusal.status}"`;
    case "too-many-labels":
      return `a task carries at most ${refusal.max} labels — take one off first`;
    case "counter-exhausted":
      return "this board's id counter is exhausted — start a new workspace board";
    case "board-read-only":
      return `the board is read-only: ${refusal.error}`;
    case "board-unreadable":
      return `the board file could not be read and is not written to until fixed: ${refusal.error}`;
    case "unknown-task":
      return `no such task: ${refusal.id}`;
    case "unknown-team":
      return `no team "${refusal.team}" in this workspace to hand it to`;
    case "transfer-closed":
      return `a ${refusal.status} task has nothing left to hand over — duplicate it to start the work again elsewhere`;
    case "transfer-same-team":
      return "that task is already on that team's board";
    case "not-yours-to-transfer":
      return `handing a task to another team is ${lead}'s — ask them`;
    case "transfer-linked": {
      const links = blockerLinkWords(refusal).join("; ");
      return `a task linked by blockers stays on its team — ${links}; unlink first (blockers do not cross teams)`;
    }
  }
}
