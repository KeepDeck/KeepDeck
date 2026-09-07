/**
 * Bringing agents and teams into being: `agent.spawn`, `team.create`,
 * `team.add`.
 *
 * Together because they share one thing that is genuinely one thing — what
 * arriving in a workspace entails, which `recruit` owns: the agent and its
 * mode, the pane and its name, the task, the landing and its refusals, the
 * selection. The doors differ only in WHERE the pane asks to land.
 */
import {
  agentSupportsNew,
  agentSupportsYolo,
} from "../../domain/agents";
import {
  resolveTeamRef,
  type CommandArgs,
  type CommandRegistry,
} from "../../domain/commands";
import {
  findTeam,
  findWorkspaceByRef,
  paneId,
  roleTaken,
  teamNameTaken,
  TEAM_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  placementRefusalMessage,
  type Pane,
  type TeamLocation,
  type Workspace,
} from "../../domain/deck";
import { log } from "../../ipc/log";
import { inspectRepo } from "../../ipc/worktree";
import { firstFreeTeamWorktreeFor, nextAgentIndex, nextAgentType } from "../newAgentDefaults";
import { mintAgentSeq } from "../ids";
import { parseRoleAddress } from "../../domain/mail";
import { getSettings } from "../settingsManager";
import type {
  CreatePaneRequest,
} from "../agentOrchestrator";
import type { Deck } from "../useDeck";
import { requiredStr, str } from "./args";
import { deliverTask } from "./deliverTask";
import { sharedDirectoryRefusal } from "../sharedDirectoryMessage";

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
  targetWorkspace,
  worktreeAhead,
} from "./targets";

export function registerTeamCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): (() => void)[] {
  /**
   * What every create shares — the agent and its mode, the pane and its
   * name, the task, the landing and its refusals, the selection — so the
   * two doors (`agent.spawn`, `team.add`) differ only in WHERE the pane
   * asks to land. `where` answers that against the LIVE
   * workspace, since a repo inspect or a worktree suggestion is an await
   * the workspace can close across.
   */
  async function recruit(
    args: CommandArgs,
    where: (
      current: { deck: Deck; workspace: Workspace },
      index: number,
    ) => Promise<Pick<CreatePaneRequest, "placement" | "team" | "role" | "teamName">>,
  ) {
    const deck = deps.deck();
    const agents = deps.agents();
    // Declared required — read as required, so a blank one is refused
    // instead of quietly meaning "the active workspace".
    const ws = targetWorkspace(deck, requiredStr(args, "workspace"));
    const workspace = { id: ws.id, instance: ws.instance };
    const currentTarget = (): { deck: Deck; workspace: Workspace } => {
      const currentDeck = deps.deck();
      const currentWorkspace = findWorkspaceByRef(currentDeck.workspaces, workspace);
      if (!currentWorkspace) throw new Error(WORKSPACE_GONE_MESSAGE);
      return { deck: currentDeck, workspace: currentWorkspace };
    };
    const requested = str(args, "agentType");
    if (requested && !agents.some((a) => a.id === requested))
      throw new Error(`unknown agent type "${requested}"`);
    const agentType = requested ?? nextAgentType(agents, ws);
    if (!agentSupportsNew(agents, agentType)) {
      throw new Error(`agent type "${agentType}" does not support new sessions`);
    }
    const id = paneId(mintAgentSeq());
    const index = nextAgentIndex(ws);

    // An explicit answer wins; without one the global default reaches
    // this surface like every other creation path. Either way it is
    // gated on the resolved agent's support, so a caller cannot turn on
    // a mode the agent does not have.
    const asked = args.yolo;
    const yolo =
      (typeof asked === "boolean" ? asked : (getSettings()?.defaultYolo ?? false)) &&
      agentSupportsYolo(agents, agentType);
    const pane: Pane = {
      id,
      name: str(args, "name"),
      agentType,
      ...(yolo && { yolo: true }),
    };
    const ask = await where(currentTarget(), index);
    let current = currentTarget();

    // A full team used to swallow the add and then report a paneId that was
    // never in the deck — with the worktree already created. The `never` is
    // what makes a new refusal a compile error here: a bare switch would let
    // an unmatched outcome fall straight through to the success report.
    const landed = deps.createPane({ workspace, pane, ...ask });
    switch (landed.kind) {
      case "created":
        break;
      case "full":
        throw new Error(TEAM_FULL_MESSAGE);
      case "gone":
        throw new Error(WORKSPACE_GONE_MESSAGE);
      case "held":
        throw new Error(placementRefusalMessage(landed.why));
      default: {
        const unhandled: never = landed;
        throw new Error(`unhandled create outcome: ${JSON.stringify(unhandled)}`);
      }
    }
    current = currentTarget();
    current.deck.selectWorkspace(workspace.id);
    current.deck.selectPane(workspace.id, id);

    const task = str(args, "task");
    // The pane's whole starting story on one line: which agent, where,
    // and — the part that matters for teams — whether anything will
    // open a turn on it. A recruit spawned with no task never has one,
    // so nothing it is told can ride a turn boundary.
    log.info(
      "web:spawn",
      `${id}: ${agentType} in ${workspace.id} on ${landed.teamId}, task ${task ? "scheduled" : "none"}`,
    );
    if (task) void deliverTask(id, task);
    // The worktree ahead is the TEAM's, read off the pane as the deck now
    // holds it — the local literal above never learned which team it
    // landed on, and read through it every create answered "no worktree".
    const held = current.workspace.panes.find((candidate) => candidate.id === id) ?? pane;
    return {
      paneId: id,
      workspaceId: workspace.id,
      teamId: landed.teamId,
      agentType,
      worktree: worktreeAhead(current.workspace, held),
      task: task ? "scheduled" : "none",
    };
  }

  /** The directory a pane asks for when nobody named one: a repo workspace
   * with a base folder gets the first FREE worktree suggestion (never a dir
   * a team holds, nor one blocked on disk) — a team of its own; anything
   * else the workspace root. Mirrors the agent dialog's defaults. */
  async function freshWorktree(
    current: { deck: Deck; workspace: Workspace },
    index: number,
  ): Promise<TeamLocation | undefined> {
    const info = await inspectRepo(current.workspace.cwd).catch(() => null);
    if (!info?.isRepo) return undefined;
    const free = await firstFreeTeamWorktreeFor(
      current.deck.workspaces,
      current.workspace,
      index,
    );
    if (!free) return undefined;
    return {
      kind: "provisioning",
      intent: { repo: current.workspace.cwd, path: free.path, branch: free.branch, index },
    };
  }

  /** The team a command named, by id or name, in the workspace it acts on. */
  function teamRef(workspace: Workspace, ref: string) {
    const resolved = resolveTeamRef(workspace, ref);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.value;
  }

  /** The role a recruit is asked to take — a role this deck knows, free on
   * the team — or the refusal in words. */
  function askedRole(workspace: Workspace, teamId: string, role: string | undefined) {
    if (role === undefined) return undefined;
    if (!parseRoleAddress(role)) throw new Error(`"${role}" is not a role this deck knows`);
    if (roleTaken(workspace, teamId, role)) {
      throw new Error(`role "${role}" is taken on that team — a role is an address, so it has to be unique`);
    }
    return role;
  }

  return [
    registry.register({
      id: "agent.spawn",
      title: "Spawn an agent in a workspace",
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
        {
          name: "agentType",
          type: "string",
          description: "Agent id from the catalog (claude, codex, opencode)",
        },
        { name: "name", type: "string", description: "Pane name" },
        {
          name: "role",
          type: "string",
          description: "The role it takes on its team — how teammates address it; suggested when omitted",
        },
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
       * without, a team minted for the pane under an auto name — a
       * worktree of its own when the workspace can make one, else the
       * root. Answers the team the agent landed on either way. */
      run: (args) =>
        recruit(args, async (current, index) => {
          const ref = str(args, "team");
          if (ref !== undefined) {
            const team = teamRef(current.workspace, ref);
            const role = askedRole(current.workspace, team.id, str(args, "role"));
            return { team: team.id, ...(role !== undefined && { role }) };
          }
          // A new team has no roster to clash with, but the role still has
          // to be one the deck knows — the contract `team.add` holds, so
          // the facade cannot mint a member no roster reads.
          const role = str(args, "role");
          if (role !== undefined && !parseRoleAddress(role)) {
            throw new Error(`"${role}" is not a role this deck knows`);
          }
          const placement = await freshWorktree(current, index);
          return {
            ...(placement !== undefined && { placement }),
            ...(role !== undefined && { role }),
          };
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
        let placement: TeamLocation;
        if (directory === undefined) {
          // The repo inspect is an await the workspace can close across:
          // everything after it reads the LIVE workspace again.
          const fresh = await freshWorktree({ deck: deps.deck(), workspace: ws }, nextAgentIndex(ws));
          if (!fresh) {
            throw new Error(
              "a new worktree needs a git repository with a worktree base folder — pass directory: \"root\" or an existing directory",
            );
          }
          placement = fresh;
        } else {
          placement = { kind: "attached", cwd: directory === "root" ? ws.cwd : directory };
        }
        const current = live();
        const taken = () =>
          new Error(`a team called “${name}” already exists — team.add puts an agent on it`);
        if (name && teamNameTaken(current, name)) throw taken();
        // The create settles whose the directory is — one answer, the same
        // one the "+ Team" door gets — and says so with the holder's name,
        // which a bare refusal could not: an agent told WHICH team is there
        // knows what to call in team.add. `shared` is that agent saying what
        // the dialog asks the person: both teams work in the one directory,
        // deliberately.
        const made = deps.createTeam({
          workspace,
          name: name ?? "",
          placement,
          ...(args.shared === true && { shared: true as const }),
        });
        switch (made.kind) {
          case "created":
            break;
          case "gone":
            throw new Error(WORKSPACE_GONE_MESSAGE);
          case "shared":
            throw new Error(sharedDirectoryRefusal(made.holder));
          case "held":
            throw new Error(placementRefusalMessage(made.why));
          case "taken":
            throw taken();
          default: {
            const unhandled: never = made;
            throw new Error(`unhandled team outcome: ${JSON.stringify(unhandled)}`);
          }
        }
        const settled = live();
        deps.deck().selectWorkspace(workspace.id);
        // Read back rather than echoed: the name may be the auto one, and
        // the worktree ahead is the team's card as the deck now holds it.
        const team = findTeam(settled, made.teamId);
        const ahead =
          team?.location?.kind === "provisioning"
            ? { path: team.location.intent.path, branch: team.location.intent.branch ?? null }
            : null;
        log.info("web:spawn", `${made.teamId} (${team?.name ?? name ?? "?"}): team made in ${workspace.id}, nobody on it yet`);
        return {
          teamId: made.teamId,
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
        {
          name: "agentType",
          type: "string",
          description: "Agent id from the catalog (claude, codex, opencode)",
        },
        { name: "name", type: "string", description: "Pane name" },
        {
          name: "role",
          type: "string",
          description: "The role it takes — how teammates address it; suggested when omitted",
        },
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
        recruit(args, async (current) => {
          const team = teamRef(current.workspace, requiredStr(args, "team"));
          const role = askedRole(current.workspace, team.id, str(args, "role"));
          return { team: team.id, ...(role !== undefined && { role }) };
        }),
    }),
  ];
}
