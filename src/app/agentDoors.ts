/**
 * What confirming the agent dialog DOES — the "+ Team" and "Add member"
 * doors, as one owner.
 *
 * The dialog collects; this decides. A new team is made and entered. A
 * member is landed on its team, or its recorded session is resumed, or
 * forked into the team's directory. Every refusal comes back as WORDS the
 * door only has to show, and a directory another team already works in
 * comes back as a QUESTION carrying the create to re-issue once the person
 * answers — so the door holds no retry of its own.
 *
 * All of this used to live inside the dialog's hook: a use case, with its
 * re-issue and four refusal mappings, in the presentation layer, where a
 * view's test could not reach it and a second surface would have copied it.
 * The hook now holds what a hook should — whether the dialog is open and
 * whether a question is standing — and asks here.
 */
import type { AgentDialogResult, AgentDialogTarget } from "../domain/agents";
import {
  findWorkspaceByRef,
  paneFromAgentRequest,
  placementRefusalMessage,
  WORKSPACE_GONE_MESSAGE,
  type PaneRequest,
  type Workspace,
} from "../domain/deck";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { describeError } from "../ipc/log";
import {
  createRefusalMessage,
  type AgentOrchestrator,
  type DirectoryHolder,
} from "./agentOrchestrator";

/** A confirmed dialog: what it was opened for, and what the person chose. */
export interface DoorRequest {
  /** The exact workspace lifetime the dialog opened for — a replacement
   * under the same public id is not it. */
  workspace: WorkspaceRef;
  /** The pane id minted when the dialog opened. */
  agentId: string;
  /** The agent's index in the workspace, for the location's naming. */
  index: number;
  target: AgentDialogTarget;
  result: AgentDialogResult;
}

/** Which door a refusal is about — the surface picks the notice by it. */
export type DoorName = "team" | "member" | "resume" | "fork";

export type DoorOutcome =
  | { kind: "done" }
  /** Refused, in the words every door uses for that refusal. */
  | { kind: "refused"; door: DoorName; message: string }
  /** Not a refusal: the directory is another team's, and the person has
   * not been asked whether a second team may work there. `anyway` is the
   * SAME create, re-issued with the answer. */
  | { kind: "ask-shared"; holder: DirectoryHolder; path: string; anyway(): DoorOutcome };

export interface AgentDoors {
  confirm(request: DoorRequest): Promise<DoorOutcome>;
}

export interface AgentDoorsDeps {
  orchestrator: Pick<
    AgentOrchestrator,
    "createTeam" | "createPane" | "resumeSession" | "forkSession"
  >;
  deck: {
    workspaces(): Workspace[];
    /** Enter the team just made — where the person's attention is. */
    openTeam(workspaceId: string, teamId: string): void;
  };
}

const DONE: DoorOutcome = { kind: "done" };
const refused = (door: DoorName, message: string): DoorOutcome => ({
  kind: "refused",
  door,
  message,
});

export function createAgentDoors(deps: AgentDoorsDeps): AgentDoors {
  const { orchestrator, deck } = deps;

  /** The "+ Team" door: a team and nothing else — no agent lands here. */
  function makeTeam(
    workspace: WorkspaceRef,
    name: string,
    placement: PaneRequest["placement"],
  ): DoorOutcome {
    // Issued twice at most: once as asked, and once more carrying the
    // answer to "another team works here — create anyway?".
    const make = (shared?: true): DoorOutcome => {
      const made = orchestrator.createTeam({
        workspace,
        name,
        placement,
        ...(shared && { shared }),
      });
      switch (made.kind) {
        case "created":
          deck.openTeam(workspace.id, made.teamId);
          return DONE;
        case "gone":
          return refused("team", WORKSPACE_GONE_MESSAGE);
        case "shared":
          // Only the create knows WHOSE the directory is, and the answer
          // is a decision, not a correction to make in a field.
          return {
            kind: "ask-shared",
            holder: made.holder,
            path: made.directory,
            anyway: () => make(true),
          };
        case "held":
          return refused("team", placementRefusalMessage(made.why));
        case "taken":
          return refused("team", `A team called “${name.trim()}” already exists here.`);
        default: {
          const unhandled: never = made;
          throw new Error(`unhandled team outcome: ${JSON.stringify(unhandled)}`);
        }
      }
    };
    return make();
  }

  return {
    async confirm(request) {
      const { workspace, target, result } = request;
      const ws = findWorkspaceByRef(deck.workspaces(), workspace);
      if (!ws) {
        // Said rather than returned quietly: the dialog has already closed,
        // so silence is an agent the person asked for that never appears.
        return refused(target.kind === "new-team" ? "team" : "member", WORKSPACE_GONE_MESSAGE);
      }
      // The request's directory, as the domain reads the dialog's location:
      // the root, an existing directory, or a create heading for one.
      const asked = paneFromAgentRequest(request.agentId, result, ws, request.index);
      if (target.kind === "new-team") {
        return makeTeam(workspace, result.teamName ?? target.suggestedName, asked.placement);
      }

      // A member runs where its team runs: a resume is offered only for a
      // session recorded in the team's directory, and a fork copies the
      // session INTO that directory. The role the person picked rides every
      // way in, and the landing honours it or refuses it.
      const name = result.name.trim() || undefined;
      const opts = {
        name,
        yolo: result.yolo,
        ...(result.role !== undefined && { role: result.role }),
      };
      const { session } = result;
      if (session?.mode === "resume") {
        try {
          await orchestrator.resumeSession(workspace.id, session.handle, opts);
          return DONE;
        } catch (error: unknown) {
          return refused("resume", describeError(error));
        }
      }
      if (session?.mode === "fork") {
        if (target.cwd === null) return refused("fork", "the team's directory is not there yet");
        try {
          await orchestrator.forkSession(
            workspace.id,
            session.handle,
            { kind: "dir", cwd: target.cwd },
            opts,
          );
          return DONE;
        } catch (error: unknown) {
          return refused("fork", describeError(error));
        }
      }
      // A fresh member: the pane the request describes, joining its team by
      // id — the directory is the team's, not the dialog's to choose.
      const landed = orchestrator.createPane({
        workspace,
        pane: asked.pane,
        team: target.teamId,
        ...(result.role !== undefined && { role: result.role }),
      });
      return landed.kind === "created" ? DONE : refused("member", createRefusalMessage(landed));
    },
  };
}
