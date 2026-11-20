/**
 * What confirming the agent dialog DOES — the "+ Team" and "Add member"
 * doors, as one owner.
 *
 * The dialog collects; this asks. A new team is made and entered. A member
 * is seated on its team, or its recorded session is resumed, or forked into
 * the team's directory. Each is one intent to the lifecycle machine, which
 * makes the ids; every refusal comes back as WORDS the door only has to
 * show, and a directory another team already works in comes back as a
 * QUESTION carrying the create to issue once the person answers — so the
 * door holds no retry of its own.
 */
import type { AgentDialogResult, AgentDialogTarget } from "../domain/agents";
import type { SessionHandle } from "../domain/journal";
import { findTeam, findWorkspaceByRef, NO_AGENT_MESSAGE, WORKSPACE_GONE_MESSAGE, type DirectoryHolder, type Workspace } from "../domain/deck";
import { agentDraftFromRequest, siteFromAgentRequest, type IntentOutcome, type Site } from "../domain/lifecycle";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { intentOutcomeText } from "../presentation/lifecycleWords";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { teamBirthBlock } from "./teamBirth";

/** A confirmed dialog: what it was opened for, and what the person chose. */
export interface DoorRequest {
  /** The exact workspace lifetime the dialog opened for — a replacement
   * under the same public id is not it. */
  workspace: WorkspaceRef;
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
   * SAME create, issued once the person says yes. */
  | { kind: "ask-shared"; holder: DirectoryHolder; path: string; anyway(): Promise<DoorOutcome> };

/** A recorded session continued onto a team without the dialog — the
 * empty team's sessions list, where the role is the one thing asked. */
export interface ContinueRequest {
  workspace: WorkspaceRef;
  teamId: string;
  session: { mode: "resume" | "fork"; handle: SessionHandle };
  role: string;
}

export interface AgentDoors {
  confirm(request: DoorRequest): Promise<DoorOutcome>;
  continueSession(request: ContinueRequest): Promise<DoorOutcome>;
}

export interface AgentDoorsDeps {
  orchestrator: Pick<AgentOrchestrator, "createTeam" | "createPane" | "resumeSession" | "forkSession">;
  deck: {
    workspaces(): Workspace[];
    /** Enter the team just made — where the person's attention is. */
    openTeam(workspaceId: string, teamId: string): void;
  };
  /** The teams the lifecycle machine says work in a folder. */
  teamsIn(path: string): Promise<string[]>;
}

const DONE: DoorOutcome = { kind: "done" };
const refused = (door: DoorName, message: string): DoorOutcome => ({ kind: "refused", door, message });

/** A door's answer to what the machine said: done, or its refusal's words. */
function answered(door: DoorName, outcome: IntentOutcome): DoorOutcome {
  const words = intentOutcomeText(outcome);
  return words === null ? DONE : refused(door, words);
}

export function createAgentDoors(deps: AgentDoorsDeps): AgentDoors {
  const { orchestrator, deck } = deps;

  /** The "+ Team" door: a team and nothing else — no agent lands here. */
  async function makeTeam(ws: Workspace, workspace: WorkspaceRef, name: string, site: Site): Promise<DoorOutcome> {
    const make = async (): Promise<DoorOutcome> => {
      const made = await orchestrator.createTeam({ workspace, name, site });
      if (made.kind === "accepted" && made.minted.team !== null) deck.openTeam(workspace.id, made.minted.team);
      return answered("team", made);
    };
    const block = await teamBirthBlock({ ws, workspaces: deck.workspaces(), name, site, teamsIn: deps.teamsIn });
    if (block?.kind === "taken") return refused("team", `A team called “${block.name}” already exists here.`);
    // Only the machine knows WHOSE the directory is, and the answer is a
    // decision, not a correction to make in a field.
    if (block?.kind === "shared") return { kind: "ask-shared", holder: block.holder, path: block.path, anyway: make };
    return make();
  }

  /** A recorded session continued onto a member's team — resumed in place,
   * or forked INTO the team's directory. Both land on THIS team, by id: two
   * teams can share a directory. The role rides along, and the landing
   * honours it or refuses it. */
  async function continueOnto(
    workspace: WorkspaceRef,
    team: { teamId: string; cwd: string | null },
    session: ContinueRequest["session"],
    opts: { name?: string; yolo?: boolean; role: string },
  ): Promise<DoorOutcome> {
    const landing = { ...opts, team: team.teamId };
    if (session.mode === "resume") {
      return answered("resume", await orchestrator.resumeSession(workspace.id, session.handle, landing));
    }
    if (team.cwd === null) return refused("fork", "the team's directory is not there yet");
    return answered("fork", await orchestrator.forkSession(workspace.id, session.handle, { kind: "dir", cwd: team.cwd }, landing));
  }

  return {
    async continueSession({ workspace, teamId, session, role }) {
      const ws = findWorkspaceByRef(deck.workspaces(), workspace);
      const team = ws ? findTeam(ws, teamId) : undefined;
      if (!team) return refused(session.mode, WORKSPACE_GONE_MESSAGE);
      const cwd = team.location?.kind === "attached" ? team.location.cwd : null;
      return continueOnto(workspace, { teamId, cwd }, session, { role });
    },

    async confirm({ workspace, target, result }) {
      const ws = findWorkspaceByRef(deck.workspaces(), workspace);
      if (!ws) {
        // Said rather than returned quietly: the dialog has already closed,
        // so silence is an agent the person asked for that never appears.
        return refused(target.kind === "new-team" ? "team" : "member", WORKSPACE_GONE_MESSAGE);
      }
      if (target.kind === "new-team") {
        return makeTeam(ws, workspace, result.teamName ?? target.suggestedName, siteFromAgentRequest(result));
      }
      const { agentType } = result;
      if (agentType === null) return refused("member", NO_AGENT_MESSAGE);
      // An absent role is the role rule's to refuse, in its own words.
      const role = result.role ?? "";

      // A member runs where its team runs: a resume is offered only for a
      // session recorded in the team's directory, and a fork copies the
      // session INTO that directory.
      const { session } = result;
      if (session) {
        return continueOnto(workspace, target, session, {
          name: result.name.trim() || undefined,
          yolo: result.yolo,
          role,
        });
      }
      // A fresh member, joining its team by id — the directory is the
      // team's, not the dialog's to choose.
      const seated = await orchestrator.createPane({
        workspace,
        pane: agentDraftFromRequest(agentType, result),
        team: target.teamId,
        role,
      });
      return answered("member", seated);
    },
  };
}
