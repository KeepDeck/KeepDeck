import type { CommandArgs, CommandRegistry } from "../../domain/commands";
import { createFailed, createIsOut, teamNameTaken } from "../../domain/deck";
import { requiredStr, str } from "./args";
import type { CoreCommandDeps } from ".";
import { targetTeam, targetWorkspace } from "./targets";

/**
 * A team's life after it is born: `team.enter`, `team.rename`, `team.retry`
 * and `team.disband` — the acts the stage card offers, as tools. Landing a
 * team or an agent is `./spawn`'s; this module owns nothing a card cannot
 * do, and each tool wraps the owner the card already calls, so a person and
 * an agent reach one behaviour through one door — and a destructive one
 * keeps its human confirmation the way `agent.close` does.
 */
export function registerTeamLifecycleCommands(
  registry: CommandRegistry,
  deps: Pick<
    CoreCommandDeps,
    "deck" | "activateTeam" | "requestDisbandTeam" | "retryProvisioning"
  >,
): (() => void)[] {
  const TEAM = {
    name: "team",
    type: "string",
    required: true,
    description: "Team id or name (see workspace.list teams)",
  } as const;
  const WORKSPACE = {
    name: "workspace",
    type: "string",
    description: "Workspace name or id; the active one when omitted",
  } as const;

  /** The workspace and team a call names — where every tool here starts. */
  const named = (args: CommandArgs) => {
    const ws = targetWorkspace(deps.deck(), str(args, "workspace"));
    const team = targetTeam(ws, requiredStr(args, "team"));
    return { ws, team };
  };

  return [
    registry.register({
      id: "team.enter",
      title: "Open a team on the stage — its workspace on screen, its agents laid out",
      args: [TEAM, WORKSPACE],
      run: (args) => {
        const { ws, team } = named(args);
        deps.activateTeam(ws.id, team.id);
        return { workspaceId: ws.id, teamId: team.id };
      },
    }),
    registry.register({
      id: "team.rename",
      title: "Rename a team — the name people and teammates address it by",
      args: [
        TEAM,
        {
          name: "name",
          type: "string",
          required: true,
          description:
            "The new name; refused when another team in the workspace already answers to it",
        },
        WORKSPACE,
      ],
      run: (args) => {
        const { ws, team } = named(args);
        const name = requiredStr(args, "name");
        // Refused in words: the deck's own rename answers a taken name with
        // the same array, and an agent cannot see a silent no-op — it keeps
        // addressing a team by a name it never got.
        if (teamNameTaken(ws, name, team.id)) {
          throw new Error(`a team called “${name}” already exists here — pick another name`);
        }
        deps.deck().renameTeam(ws.id, team.id, name);
        return { workspaceId: ws.id, teamId: team.id, name };
      },
    }),
    registry.register({
      id: "team.retry",
      title: "Retry a team's failed worktree create — the card's Retry",
      args: [TEAM, WORKSPACE],
      run: (args) => {
        const { ws, team } = named(args);
        const location = team.location;
        // Only a FAILED create is retried: one still running would be
        // issued twice, and a team that already runs has nothing to make.
        // Both are said, because the card shows Retry only when it applies
        // and an agent sees no card — asked through the domain's own two
        // questions, the same ones the card's rim and the roster ask.
        if (createIsOut(location)) {
          throw new Error(
            `team "${team.name}" has nothing to retry — its worktree is still being created`,
          );
        }
        if (!createFailed(location) || location?.kind !== "provisioning") {
          throw new Error(
            `team "${team.name}" has nothing to retry — it is not waiting on a worktree create`,
          );
        }
        deps.retryProvisioning(ws.id, team.id);
        return {
          workspaceId: ws.id,
          teamId: team.id,
          worktree: { path: location.intent.path, branch: location.intent.branch ?? null },
        };
      },
    }),
    registry.register({
      id: "team.disband",
      title: "Disband a team (opens the confirm dialog, worktree offer included)",
      args: [TEAM, WORKSPACE],
      run: (args) => {
        const { ws, team } = named(args);
        deps.requestDisbandTeam(ws.id, team.id);
        return { workspaceId: ws.id, teamId: team.id, name: team.name, confirm: "dialog" };
      },
    }),
  ];
}
