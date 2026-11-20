import { agentSupportsNew, agentSupportsYolo } from "../../domain/agents";
import type { CommandArgs, CommandRegistry } from "../../domain/commands";
import { findPane, findTeam, findWorkspaceByRef, WORKSPACE_GONE_MESSAGE, type Workspace } from "../../domain/deck";
import type { AgentDraft, Site } from "../../domain/lifecycle";
import { sharedDirectoryRefusal } from "../sharedDirectoryMessage";
import { teamBirthBlock } from "../teamBirth";
import { log } from "../../ipc/log";
import { inspectRepo } from "../../ipc/worktree";
import { nextAgentType, nextYolo } from "../newAgentDefaults";
import type { CreatePaneRequest } from "../agentOrchestrator";
import { requiredStr, str } from "./args";
import { deliverTask } from "./deliverTask";
import { refusedBy } from "./refused";
import type { CoreCommandDeps } from ".";
import { requireUnarchived, targetTeam, targetWorkspace, worktreeAhead } from "./targets";

/**
 * Landing agents and teams: `agent.spawn`, `team.create`, `team.add` — the
 * three doors onto the same lifecycle intents the dialogs send. One module
 * because they share the recruit (the agent, its mode, the task, the
 * landing and its refusals) and only differ in WHERE the pane asks to land.
 * The ids of what they make are the machine's, read from its answer.
 */
/** One description for the role both doors take: nobody picks it for the
 * agent, so the caller has to know what a team will accept. */
const ROLE_ARG = {
  name: "role",
  type: "string",
  required: true,
  description:
    "The role it takes on its team — how teammates address it; nobody picks one for it. An address (impl-2) as it is, or a role (impl, peer) at its next free address. A team with nobody on it takes lead or a peer; a led team its working roles; a flat team more peers. Refused when taken, unknown, or a shape the team cannot have",
} as const;

/** The agent the pane runs. No ids are listed: the installed plugins are
 * the catalog, and a list written here would be the host naming agents. */
const AGENT_TYPE_ARG = {
  name: "agentType",
  type: "string",
  description:
    "An installed agent's id, as workspace.list shows a pane's agentType; omitted, the agent the workspace used last, else the default agent",
} as const;

export function registerSpawnCommands(
  registry: CommandRegistry,
  deps: Pick<CoreCommandDeps, "deck" | "agents" | "createPane" | "createTeam" | "teamsIn">,
): (() => void)[] {
  /**
   * What every create shares — the agent and its mode, the pane and its
   * name, the task, the landing and its refusals, the selection — so the
   * two doors (`agent.spawn`, `team.add`) differ only in WHERE the pane
   * asks to land. `where` answers that against the LIVE workspace, since a
   * repo inspect is an await the workspace can close across.
   */
  async function recruit(
    args: CommandArgs,
    where: (current: Workspace) => Promise<Pick<CreatePaneRequest, "site" | "team" | "role">>,
  ) {
    const deck = deps.deck();
    const agents = deps.agents();
    // Declared required — read as required, so a blank one is refused
    // instead of quietly meaning "the active workspace".
    const ws = targetWorkspace(deck, requiredStr(args, "workspace"));
    const workspace = { id: ws.id, instance: ws.instance };
    const live = (): Workspace => {
      const current = findWorkspaceByRef(deps.deck().workspaces, workspace);
      if (!current) throw new Error(WORKSPACE_GONE_MESSAGE);
      // Archived across the await: refused like at the door.
      return requireUnarchived(current);
    };
    const requested = str(args, "agentType");
    if (requested && !agents.some((a) => a.id === requested))
      throw new Error(`unknown agent type "${requested}"`);
    const agentType = requested ?? nextAgentType(agents, ws);
    // No agent at all — none installed, or the catalog not loaded yet:
    // refused before anything is asked of the machine, so nothing is left
    // behind and the caller can retry once there is one.
    if (agentType === null) {
      throw new Error("no agent available: install or enable an agent plugin, or pass agentType");
    }
    if (!agentSupportsNew(agents, agentType)) {
      throw new Error(`agent type "${agentType}" does not support new sessions`);
    }

    // An explicit answer wins; without one the global default reaches
    // this surface like every other creation path. Either way it is
    // gated on the resolved agent's support, so a caller cannot turn on
    // a mode the agent does not have.
    const asked = args.yolo;
    const yolo = (typeof asked === "boolean" ? asked : nextYolo()) && agentSupportsYolo(agents, agentType);
    const name = str(args, "name");
    const pane: AgentDraft = { agentType, ...(name && { name }), ...(yolo && { yolo: true }) };
    const ask = await where(live());
    // Closed, replaced or archived across the await: refused before the
    // machine is asked for anything.
    live();

    // Every refusal — a full team, a gone workspace, a held place, a role
    // that is taken or unknown — is said in the one spelling every door
    // uses: the machine and the deck decide, this door only tells.
    const landed = await deps.createPane({ workspace, pane, ...ask });
    if (landed.kind !== "accepted") throw refusedBy(landed);
    const id = landed.minted.panes[0];
    if (id === undefined) throw new Error("the lifecycle made no agent");
    const current = live();
    deps.deck().selectWorkspace(workspace.id);
    deps.deck().selectPane(workspace.id, id);
    const held = findPane([current], current.id, id);
    const teamId = held?.team?.teamId ?? landed.minted.team ?? ask.team ?? null;

    const task = str(args, "task");
    // The pane's whole starting story on one line: which agent, where,
    // and — the part that matters for teams — whether anything will
    // open a turn on it. A recruit spawned with no task never has one,
    // so nothing it is told can ride a turn boundary.
    log.info("web:spawn", `${id}: ${agentType} in ${workspace.id} on ${teamId ?? "?"}, task ${task ? "scheduled" : "none"}`);
    if (task) void deliverTask(id, task);
    return {
      paneId: id,
      workspaceId: workspace.id,
      teamId,
      agentType,
      // The worktree ahead is the TEAM's, read off the pane as the deck
      // now holds it.
      worktree: held ? worktreeAhead(current, held) : null,
      task: task ? "scheduled" : "none",
    };
  }

  /** Where a team goes when nobody named a folder: a new worktree at the
   * machine's next free place in a repo workspace with a base folder, else
   * the workspace root. Mirrors the agent dialog's defaults. */
  async function freshSite(ws: Workspace): Promise<Site | null> {
    if (!ws.worktreeBaseDir) return null;
    const info = await inspectRepo(ws.cwd).catch(() => null);
    return info?.isRepo ? { kind: "new", place: null, base: null } : null;
  }

  return [
    registry.register({
      id: "agent.spawn",
      title: "Start an agent — on a new team of its own, or on `team`",
      args: [
        {
          name: "workspace",
          type: "string",
          required: true,
          description: "Workspace name or id",
        },
        {
          name: "team",
          type: "string",
          description:
            "Team id or name to join (see workspace.list teams); omitted, the agent gets a team of its own — a new worktree in a repo workspace with a base folder, else the workspace root",
        },
        AGENT_TYPE_ARG,
        { name: "name", type: "string", description: "Pane name" },
        ROLE_ARG,
        {
          name: "yolo",
          type: "boolean",
          description:
            "Run without permission prompts; omitted follows the global default",
        },
        {
          name: "task",
          type: "string",
          description: "Initial prompt, typed into the agent once it starts",
        },
      ],
      /** The compatibility door: with a `team`, the same as `team.add`;
       * without, a team made for the pane under an auto name — a worktree
       * of its own when the workspace can make one, else the root's team.
       * Answers the team the agent landed on either way. */
      run: (args) =>
        recruit(args, async (current) => {
          const ref = str(args, "team");
          // The role rides to the landing as asked: whether it is one the
          // deck knows and free on the team is the landing's one rule.
          const role = requiredStr(args, "role");
          if (ref !== undefined) return { team: targetTeam(current, ref).id, role };
          const site = await freshSite(current);
          return { ...(site !== null && { site }), role };
        }),
    }),
    registry.register({
      id: "team.create",
      title: "Create a team",
      args: [
        {
          name: "workspace",
          type: "string",
          required: true,
          description: "Workspace name or id",
        },
        {
          name: "name",
          type: "string",
          description: "The team's name — how people and teammates address it; \"Team N\" when omitted",
        },
        {
          name: "directory",
          type: "string",
          description:
            "Where the team runs: omitted, a NEW git worktree (needs a repo workspace with a worktree base folder); \"root\", the workspace folder itself; else an existing directory's path",
        },
        {
          name: "shared",
          type: "boolean",
          description:
            "Make the team even though another team already works in that directory — both run on the same files and branch. Without it, an occupied directory is refused and names its team",
        },
      ],
      /** A team is born EMPTY: a name and a directory, nobody on it yet —
       * `team.add` puts agents on it one at a time, each under its role.
       *
       * A directory a team already works in is refused by DEFAULT, naming
       * that team, because joining it (`team.add`) is what an agent usually
       * means. Teams may still share a directory — the "+ Team" door asks
       * the person and takes "create anyway" — so an agent that means it
       * says so with `shared`. A name a team here answers to is refused
       * either way. */
      run: async (args) => {
        const ws = targetWorkspace(deps.deck(), requiredStr(args, "workspace"));
        const workspace = { id: ws.id, instance: ws.instance };
        const live = (): Workspace => {
          const current = findWorkspaceByRef(deps.deck().workspaces, workspace);
          if (!current) throw new Error(WORKSPACE_GONE_MESSAGE);
          return current;
        };
        const name = str(args, "name");
        const directory = str(args, "directory");
        let site: Site;
        if (directory === undefined) {
          const fresh = await freshSite(ws);
          if (!fresh) {
            throw new Error(
              "a new worktree needs a git repository with a worktree base folder — pass directory: \"root\" or an existing directory",
            );
          }
          site = fresh;
        } else {
          site = directory === "root" ? { kind: "root" } : { kind: "existing", cwd: directory };
        }
        const block = await teamBirthBlock({ ws: live(), workspaces: deps.deck().workspaces, name: name ?? "", site, teamsIn: deps.teamsIn });
        if (block?.kind === "taken") throw new Error(`a team called “${block.name}” already exists — team.add puts an agent on it`);
        // Whose the directory is, named — which a bare refusal could not:
        // an agent told WHICH team is there knows what to call in team.add.
        // `shared` is that agent saying what the dialog asks the person:
        // both teams work in the one directory, deliberately.
        if (block?.kind === "shared" && args.shared !== true) throw new Error(sharedDirectoryRefusal(block.holder));
        const made = await deps.createTeam({ workspace, name: name ?? "", site });
        if (made.kind !== "accepted") throw refusedBy(made);
        const teamId = made.minted.team;
        if (teamId === null) throw new Error("the lifecycle made no team");
        deps.deck().selectWorkspace(workspace.id);
        // Read back rather than echoed: the name may be the auto one, and
        // the worktree ahead is the team's card as the deck now holds it.
        const team = findTeam(live(), teamId);
        const ahead =
          team?.location?.kind === "provisioning"
            ? { path: team.location.intent.path, branch: team.location.intent.branch ?? null }
            : null;
        log.info("web:spawn", `${teamId} (${team?.name ?? name ?? "?"}): team made in ${workspace.id}, nobody on it yet`);
        return {
          teamId,
          workspaceId: workspace.id,
          name: team?.name ?? name ?? null,
          worktree: ahead,
        };
      },
    }),
    registry.register({
      id: "team.add",
      title: "Add an agent to a team",
      args: [
        {
          name: "workspace",
          type: "string",
          required: true,
          description: "Workspace name or id",
        },
        {
          name: "team",
          type: "string",
          required: true,
          description: "Team id or name (see workspace.list teams)",
        },
        AGENT_TYPE_ARG,
        { name: "name", type: "string", description: "Pane name" },
        ROLE_ARG,
        {
          name: "yolo",
          type: "boolean",
          description: "Run without permission prompts; omitted follows the global default",
        },
        { name: "task", type: "string", description: "Initial prompt, typed into the agent once it starts" },
      ],
      /** The agent runs where its team runs — a create still out included.
       * Sixteen on one team is the cap. */
      run: (args) =>
        recruit(args, async (current) => ({
          team: targetTeam(current, requiredStr(args, "team")).id,
          role: requiredStr(args, "role"),
        })),
    }),
  ];
}
