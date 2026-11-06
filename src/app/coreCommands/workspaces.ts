import type { CommandRegistry } from "../../domain/commands";
import {
  createFailed,
  createIsOut,
  membersOf,
  paneDisplayTitle,
  teamsOf,
  type AgentDown,
  type AgentReach,
  type Team,
} from "../../domain/deck";
import type { PaneActivity } from "../../domain/status";
import { teamOf } from "../../domain/mail";
import { requiredStr } from "./args";
import type { CoreCommandDeps } from ".";
import { targetWorkspace } from "./targets";

/** What the roster says a pane's agent is doing: the turn status while its
 * agent runs, and why not when it does not — `starting` on its way up by
 * itself, or the reason it is down (`suspended`, `exited`, …). Before its
 * first turn a running agent reads `started` (up, said nothing) or `ready`
 * (said it is at its prompt). Null: a running agent the deck has no status
 * voice for. */
export function rosterActivity(
  reach: AgentReach | null,
  activity: PaneActivity | undefined,
): PaneActivity | { state: "starting" | AgentDown } | null {
  if (reach?.kind === "down") return { state: reach.why };
  if (reach?.kind === "starting") return { state: "starting" };
  return activity ?? null;
}

/** A team's state, folded to one word for a roster reader: its worktree
 * still being created, the create failed (Retry is on offer), or ready —
 * through the domain's own two questions, so this word and the card's rim
 * cannot disagree. */
function teamStatus(team: Team): "creating" | "failed" | "ready" {
  if (createFailed(team.location)) return "failed";
  return createIsOut(team.location) ? "creating" : "ready";
}

/**
 * The `workspace.*` area of the core set: what the deck holds — workspaces,
 * their teams and panes — and which workspace is on screen.
 */
export function registerWorkspaceCommands(
  registry: CommandRegistry,
  deps: Pick<CoreCommandDeps, "deck" | "agents" | "activityOf" | "reachOf">,
): (() => void)[] {
  return [
    registry.register({
      id: "workspace.list",
      title: "List workspaces, their teams and agents",
      args: [],
      run: () => {
        const deck = deps.deck();
        const agents = deps.agents();
        return deck.workspaces.map((ws) => ({
          id: ws.id,
          name: ws.name,
          cwd: ws.cwd,
          active: ws.id === deck.activeId,
          // The teams and where each runs — the ONE place a directory is
          // answered. A pane runs where its team runs, and saying so again
          // per member answered twice, and differently while a worktree
          // was being created: the team named the branch it was heading
          // for, the pane said null. `cwd` is null while the team's
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
            agentType: p.agentType,
            // The turn status of a running agent; why not, for one that is
            // not running — a lead reads here that a teammate is suspended
            // before writing to it. Null only for a running agent the deck
            // has no status voice for: absent information, not an absent pane.
            activity: rosterActivity(deps.reachOf(p.id), deps.activityOf(p.id)),
            // Who this agent is on the team, when it is on one. The roster
            // is where an agent learns the roles it may write to, so the
            // field is here rather than behind a command of its own.
            team: teamOf(ws, p),
          })),
        }));
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
