import {
  agentSupportsNew,
  agentSupportsYolo,
  type AgentInfo,
} from "../../domain/agents";
import {
  resolvePaneRef,
  resolveTeamRef,
  resolveWorkspaceRef,
  type CommandArgs,
  type CommandRegistry,
} from "../../domain/commands";
import {
  findTeam,
  findWorkspace,
  findWorkspaceByRef,
  membersOf,
  normalizePath,
  paneAgentType,
  paneDisplayTitle,
  paneId,
  roleTaken,
  teamHeldPath,
  teamNameTaken,
  teamOfPane,
  teamsOf,
  TEAM_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  WORKTREE_HELD_MESSAGE,
  type Pane,
  type Team,
  type TeamLocation,
  type Workspace,
  paneBranch,
  paneExecutionCwd,
  paneProvisioning,
} from "../../domain/deck";
import { log } from "../../ipc/log";
import { inspectRepo } from "../../ipc/worktree";
import { firstFreeTeamWorktreeFor, nextAgentIndex, nextAgentType } from "../newAgentDefaults";
import { mintAgentSeq } from "../ids";
import { parseRoleAddress, teamOf } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { paneInputReady, pasteToPane, writeRawToPane } from "../paneInput";
import { getSettings } from "../settingsManager";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
  CreateTeamOutcome,
  CreateTeamRequest,
  ResumeRequest,
} from "../agentOrchestrator";
import { resumeRefusalText } from "../resumeOutcome";
import type { SkillsLibrary } from "../skillsLibrary";
import { suspendRefusalText, type SuspendOutcome } from "../suspendOutcome";
import type { Deck } from "../useDeck";
import { requiredStr, str, text } from "./args";
import { deliverTask } from "./deliverTask";
import { registerSkillsCommands } from "./skills";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. The plain
 * application controller registers once; accessors read the current store and
 * current UI port for every invocation. This is the STATIC registration
 * lifecycle; feature-gated command sets have their own register/dispose
 * lifecycle. The split is deliberate: a feature toggle must not re-register
 * or tear down the core set.
 */
export interface CoreCommandDeps {
  deck(): Deck;
  agents(): AgentInfo[];
  /** What a pane's agent is doing, when anything reports for it.
   *
   * The roster carries it because the deck can SEE this from outside and a
   * session cannot see it at all. An agent that has to ask a teammate "are
   * you done yet?" spends a turn, waits for a reply, and pays for both — so
   * every question the host can already answer belongs in the answer it
   * gives for free. */
  activityOf(paneId: string): PaneActivity | undefined;
  /** Select a pane and hand keyboard input to its live terminal. */
  activatePane(wsId: string, paneId: string): void;
  /** Open the close-confirm flow — voice/MCP closes go through the same
   * dialog as ⌘W, so the destructive step keeps its human confirmation. */
  requestCloseAgent(wsId: string, paneId: string, label: string): void;
  /** Stop an agent, keeping its pane — the same flow as ⇧⌘W. Resolves to
   * whether it actually suspended. */
  suspendAgent(wsId: string, paneId: string): Promise<SuspendOutcome>;
  /** Ask for a stopped agent back — the same gesture as its card's Resume,
   * reporting what it did. */
  resumeAgent(wsId: string, paneId: string): ResumeRequest;
  /** Land a new agent pane, worktree create and all — the same entry point
   * the agent dialog uses, so a spawn asked for by voice or MCP goes
   * through the same sequence as one asked for by hand. */
  createPane(request: CreatePaneRequest): CreatePaneOutcome;
  /** Make a team that holds a directory and nobody yet — the same door
   * "+ Team" goes through, so a team asked for by voice or MCP is born the
   * way one asked for by hand is: empty, agents to follow one at a time. */
  createTeam(request: CreateTeamRequest): CreateTeamOutcome;
  /** Open the settings dialog; `sectionId` lands it on a specific section
   * (a plugin's `plugin:<id>`), null on the first. Answers whether it opened:
   * a command arrives with no button to have been disabled, so it asks the
   * same "may another dialog open?" gate the UI does, and a refusal that
   * reported success would leave the caller believing a surface is up. */
  openSettings(sectionId: string | null): boolean;
  /** Open the global usage-statistics surface. Same refusal contract as
   * [`openSettings`]. */
  openUsage(): boolean;
  /** The shared skills library, for the `skills.*` set (see `./skills`). */
  skills: SkillsLibrary;
}

/** The refusal when a command asks for a surface that would stack over one
 * already up. One sentence for both openers, because to the caller they are
 * the same refusal for the same reason. */
const DIALOG_BUSY_MESSAGE =
  "Another dialog is open — close it before opening this one";


/** The workspace a command acts on: the named one, else the active one. */
/** The worktree a freshly recruited pane is heading for, as the recruit
 * answer reports it — or null once (or when) there is no create in flight. */
function worktreeAhead(
  ws: Workspace,
  pane: Pane,
): { path: string; branch: string | null } | null {
  const card = paneProvisioning(ws, pane);
  return card ? { path: card.intent.path, branch: card.intent.branch ?? null } : null;
}

/** A team's state, folded to one word for a roster reader: its worktree
 * still being created, the create failed (Retry is on offer), or ready. */
function teamStatus(team: Team): "creating" | "failed" | "ready" {
  if (team.location?.kind !== "provisioning") return "ready";
  return team.location.error !== undefined ? "failed" : "creating";
}

function targetWorkspace(deck: Deck, ref: string | undefined): Workspace {
  if (ref) {
    const resolved = resolveWorkspaceRef(deck.workspaces, ref);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.value;
  }
  // Through the domain's by-id selector, whose own doc says it exists so callers
  // stop re-implementing this `find` — two of them had.
  const active = findWorkspace(deck.workspaces, deck.activeId);
  if (!active) throw new Error("no active workspace");
  return active;
}

function targetPane(
  deck: Deck,
  agents: AgentInfo[],
  ws: Workspace,
  ref: string | undefined,
): Pane {
  if (ref) {
    const resolved = resolvePaneRef(ws, agents, ref);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.value;
  }
  const selected = ws.panes.find((p) => p.id === deck.viewOf(ws.id).select);
  if (selected) return selected;
  if (ws.panes.length === 1) return ws.panes[0];
  // Told apart because the remedies differ: one is answered by naming a pane,
  // the other only by starting one. A workspace is born empty, so the second
  // is what a caller addressing a fresh workspace actually hits.
  if (ws.panes.length === 0)
    throw new Error(
      `workspace "${ws.name}" has no agents — spawn one first`,
    );
  throw new Error(`no agent selected in workspace "${ws.name}"`);
}

/** Register the core commands; returns the combined unregister. */
export function registerCoreCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): () => void {
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
        throw new Error(WORKTREE_HELD_MESSAGE);
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

  const disposers = [
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
      ],
      /** One directory is one team, and a team is born EMPTY: a name and
       * a directory, nobody on it yet — `team.add` puts agents on it one at
       * a time, each under its role. A directory some team already holds
       * is refused (`team.add` is the door onto that team), as is a name a
       * team here answers to. The same door "+ Team" goes through. */
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
        // Said with the holder's name, which the landing's bare `held`
        // cannot: an agent told WHICH team holds the directory knows what
        // to call in team.add.
        const wanted = teamHeldPath({ location: placement });
        const holder =
          wanted === undefined
            ? undefined
            : teamsOf(current).find((team) => {
                const held = teamHeldPath(team);
                return held !== undefined && normalizePath(held) === normalizePath(wanted);
              });
        if (holder) {
          throw new Error(
            `that directory is already team “${holder.name}”'s (${holder.id}) — team.add puts an agent on it`,
          );
        }
        const made = deps.createTeam({ workspace, name: name ?? "", placement });
        switch (made.kind) {
          case "created":
            break;
          case "gone":
            throw new Error(WORKSPACE_GONE_MESSAGE);
          case "held":
            throw new Error(WORKTREE_HELD_MESSAGE);
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

    registry.register({
      id: "agent.focus",
      title: "Select an agent pane",
      args: [
        {
          name: "agent",
          type: "string",
          required: true,
          description: "Agent pane title, name, or id",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      run: (args) => {
        const deck = deps.deck();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        // `agent` is required here (unlike every other command in this set,
        // where the selected pane is the default), so a blank one must be
        // refused rather than resolve to the pane already focused.
        const pane = targetPane(deck, deps.agents(), ws, requiredStr(args, "agent"));
        deps.activatePane(ws.id, pane.id);
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),

    registry.register({
      id: "agent.close",
      title: "Close an agent pane (opens the confirm dialog)",
      args: [
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      run: (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, agents, ws, str(args, "agent"));
        const label = paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        deps.requestCloseAgent(ws.id, pane.id, label);
        return { workspaceId: ws.id, paneId: pane.id, confirm: "dialog" };
      },
    }),

    registry.register({
      id: "agent.suspend",
      title: "Suspend an agent pane (stops it, keeps the pane)",
      args: [
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      // Not destructive, and so not behind the confirm dialog `agent.close`
      // uses: the pane, its worktree and its session all survive, and the
      // agent comes back with a resume.
      run: async (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, agents, ws, str(args, "agent"));
        const label = paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        // A caller that hears "ok" must be able to believe it, and one that
        // hears "no" deserves the real reason — the same sentence the hotkey
        // shows, not a second guess at it.
        const outcome = await deps.suspendAgent(ws.id, pane.id);
        if (outcome !== "suspended") {
          throw new Error(suspendRefusalText(outcome, label));
        }
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),

    registry.register({
      id: "agent.resume",
      title: "Resume a stopped agent pane",
      args: [
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      // The inverse of `agent.suspend`. Without it an automation that parks an
      // agent has stranded it: nothing it can address brings the pane back.
      run: (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, agents, ws, str(args, "agent"));
        const label = paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        // The flow decides and reports; guessing the answer here is what let
        // the sibling command claim success for a resume that did nothing.
        // A switch rather than a chain of ifs, so a new outcome is a compile
        // error here instead of silently reporting success for it.
        const outcome = deps.resumeAgent(ws.id, pane.id);
        if (outcome === "resuming") return { workspaceId: ws.id, paneId: pane.id };
        throw new Error(resumeRefusalText(outcome, label));
      },
    }),

    registry.register({
      id: "pane.write",
      title: "Send text into an agent pane",
      args: [
        { name: "text", type: "string", required: true, description: "Text to send" },
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
        {
          name: "submit",
          type: "boolean",
          description: "Also press Enter after the text",
        },
        {
          name: "mode",
          type: "string",
          description:
            "'type' inserts raw keystrokes that stay inline and editable (no [Pasted…] collapse); 'paste' uses bracketed paste (default)",
        },
        {
          name: "focusInput",
          type: "boolean",
          description: "Select the target pane and return keyboard focus to it",
        },
      ],
      run: (args) => {
        // Validate the mode up front: a misspelled value must NOT silently
        // fall through to paste — that is the exact [Pasted…] collapse this
        // command's type mode exists to avoid (args-validation philosophy,
        // domain/commands/args.ts: reject rather than silently do nothing).
        const mode = str(args, "mode");
        if (mode !== undefined && mode !== "type" && mode !== "paste") {
          throw new Error(
            `unknown pane.write mode ${JSON.stringify(String(mode))} — expected "type" or "paste"`,
          );
        }
        const deck = deps.deck();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, deps.agents(), ws, str(args, "agent"));
        // Through the shared reader, VERBATIM: a lone space is legitimate text
        // to send a terminal, so this is the one argument kind that must not be
        // trimmed or refused for being blank.
        const payload = text(args, "text");
        if (!paneInputReady(pane.id)) {
          throw new Error("the pane has no live session");
        }
        if (mode === "type") {
          // Raw keystrokes land as if hand-typed, so the text stays inline and
          // editable — a bracketed paste is what the agent TUIs collapse into a
          // non-editable [Pasted …] placeholder. LF (0x0A, Ctrl+J) inserts a
          // soft newline in every supported agent; a raw CR (0x0D) submits
          // mid-text, so normalise EVERY line ending to LF first.
          const typed = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          if (!writeRawToPane(pane.id, typed)) {
            throw new Error("the pane has no input channel");
          }
        } else {
          // A live but TYPE-only pane (no paste channel) cannot accept a
          // pasted payload — name that distinctly from "no session".
          if (!pasteToPane(pane.id, payload)) {
            throw new Error("the pane has no paste channel");
          }
        }
        // Submit Enter is a separate RAW keystroke after the text — see
        // deliverTask for why a CR cannot ride inside the pasted payload, and
        // why a raw CR is the submit gesture in type mode too.
        if (args.submit === true) writeRawToPane(pane.id, "\r");
        if (args.focusInput === true) deps.activatePane(ws.id, pane.id);
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),

    registry.register({
      id: "settings.open",
      title: "Open settings",
      args: [],
      run: (_args, source) => {
        // A plugin lands on its OWN section; anyone else on the first. The
        // section id mirrors what SettingsDialog builds per plugin.
        const opened = deps.openSettings(
          source.kind === "plugin" ? `plugin:${source.pluginId}` : null,
        );
        if (!opened) throw new Error(DIALOG_BUSY_MESSAGE);
        return { opened: true };
      },
    }),

    registry.register({
      id: "usage.open",
      title: "Open statistics",
      args: [],
      run: () => {
        if (!deps.openUsage()) throw new Error(DIALOG_BUSY_MESSAGE);
        return { opened: true };
      },
    }),

    // The library's own set lives in its own module — this file is already long
    // enough that another area's worth of registrations belongs beside it, not
    // in it.
    ...registerSkillsCommands(registry, { deck: deps.deck, skills: deps.skills }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}
