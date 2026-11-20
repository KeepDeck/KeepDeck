/**
 * The task boards' owner for the lifecycle machine's commands. A closed
 * workspace's board is forgotten by the owner that holds it — the write
 * already on the wire lands, the ones behind it are annulled, then the file
 * goes. A disbanded team's tasks go by the board's own rule: every loaded
 * board is held to the teams its workspace has now, the team already gone
 * from the deck when its tasks are asked for. Forgetting twice is
 * forgetting once.
 */
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import type { CommandOwner } from "../lifecycleSnapshot";

export interface BoardsPort {
  /** Forget a workspace's board and drop its file. */
  forgetWorkspace(workspaceId: string): Promise<void>;
  /** Hold every loaded board to its workspace's teams as they are now. */
  retainTeams(): void;
}

const DONE: Outcome = { kind: "applied", revision: null };

export function createBoardsOwner(boards: BoardsPort): CommandOwner {
  return {
    async carry({ cmd }) {
      switch (cmd.kind) {
        case "forgetBoards":
          await boards.forgetWorkspace(cmd.workspace);
          return DONE;
        case "deleteTeamTasks":
        case "retainTeams":
          boards.retainTeams();
          return DONE;
        default:
          return { kind: "rejected", reason: `the task boards carry no ${cmd.kind} command` };
      }
    },
  };
}
