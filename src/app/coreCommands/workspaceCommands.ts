/**
 * Reading the deck: what workspaces and agents are there, which pane a name
 * points at, and which workspace is in front. Inspection only — nothing here
 * creates, ends or writes to anything.
 */
import {
  type CommandRegistry,
} from "../../domain/commands";
import {
  membersOf,
  paneAgentType,
  paneDisplayTitle,
  teamOfPane,
  teamsOf,
  paneBranch,
  paneExecutionCwd,
} from "../../domain/deck";
import { teamOf } from "../../domain/mail";
import { requiredStr } from "./args";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. The plain
 * application controller registers once; accessors read the current store and
 * current UI port for every invocation. This is the STATIC registration
 * lifecycle; feature-gated command sets have their own register/dispose
 * lifecycle. The split is deliberate: a feature toggle must not re-register
 * or tear down the core set.
 */
import type { CoreCommandDeps } from "./deps";
import {
  targetPane,
  targetWorkspace,
  teamStatus,
} from "./targets";

export function registerWorkspaceCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): (() => void)[] {

  return [
    registry.register({
      id: "workspace.list",
      title: "List workspaces and agents",
      args: [],
      run: () => {
        const deck = deps.deck();
        const agents = deps.agents();
        return deck.workspaces.map((ws) => ({
          id: ws.id,
          name: ws.name,
          cwd: ws.cwd,
          active: ws.id === deck.activeId,
          // The teams and where each runs. `cwd` is null while the team's
          // worktree is still being created — never the workspace root,
          // which is a directory the team will not run in.
          teams: teamsOf(ws).map((team) => ({
            id: team.id,
            name: team.name,
            status: teamStatus(team),
            cwd: team.location?.kind === "attached" ? team.location.cwd : null,
            branch:
              team.location?.kind === "attached"
                ? (team.location.branch ?? null)
                : (team.location?.intent.branch ?? null),
            members: membersOf(ws, team.id).map((pane) => pane.id),
          })),
          panes: ws.panes.map((p, i) => ({
            id: p.id,
            title: paneDisplayTitle(p, i, agents),
            agentType: paneAgentType(p),
            branch: paneBranch(ws, p) ?? null,
            // Null while the pane's worktree is still being created: the
            // workspace cwd would name a directory the agent will never run
            // in. Absent information, like `activity` below.
            cwd: paneExecutionCwd(ws, p),
            // Null when nothing reports — a pane that is provisioning,
            // stopped, or running a CLI with no status reporter. Absent
            // information, not an absent pane.
            activity: deps.activityOf(p.id) ?? null,
            // Who this agent is on the team, when it is on one. The roster
            // is where an agent learns the roles it may write to, so the
            // field is here rather than behind a command of its own.
            team: teamOf(ws, p),
          })),
        }));
      },
    }),

    registry.register({
      id: "pane.target",
      title: "Resolve the active pane input target",
      args: [],
      run: () => {
        const deck = deps.deck();
        const workspace = targetWorkspace(deck, undefined);
        const pane = targetPane(deck, deps.agents(), workspace, undefined);
        // The pane's team rides along for a caller that wants to add to it;
        // this is not a choice of "the active team".
        return {
          workspaceId: workspace.id,
          paneId: pane.id,
          teamId: teamOfPane(workspace, pane)?.id ?? null,
        };
      },
    }),

    registry.register({
      id: "workspace.switch",
      title: "Switch to a workspace",
      args: [
        {
          name: "workspace",
          type: "string",
          required: true,
          description: "Workspace name or id",
        },
      ],
      run: (args) => {
        const deck = deps.deck();
        // requiredStr, not str: `workspace` is declared required, and the
        // optional reader turns a blank one into "omitted" — which
        // targetWorkspace answers with the ACTIVE workspace, so a caller that
        // sent nothing usable got a report of a successful switch to where it
        // already was.
        const ws = targetWorkspace(deck, requiredStr(args, "workspace"));
        deck.selectWorkspace(ws.id);
        return { workspaceId: ws.id };
      },
    }),
  ];
}
