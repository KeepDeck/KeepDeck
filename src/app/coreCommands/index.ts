import {
  agentSupportsNew,
  agentSupportsYolo,
  type AgentInfo,
} from "../../domain/agents";
import {
  resolvePaneRef,
  resolveWorkspaceRef,
  type CommandRegistry,
} from "../../domain/commands";
import {
  findWorkspace,
  findWorkspaceByRef,
  paneAgentType,
  paneDisplayTitle,
  paneId,
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  type Pane,
  type Workspace,
} from "../../domain/deck";
import { inspectRepo } from "../../ipc/worktree";
import { firstFreeAgentWorktree, nextAgentIndex, nextAgentType } from "../newAgentDefaults";
import { mintAgentSeq } from "../ids";
import { teamOf } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { paneInputReady, pasteToPane, writeRawToPane } from "../paneInput";
import { getSettings } from "../settingsManager";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
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
 * current UI port for every invocation.
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
   * the "+ Agent" dialog uses, so a spawn asked for by voice or MCP goes
   * through the same sequence as one asked for by hand. */
  createPane(request: CreatePaneRequest): CreatePaneOutcome;
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
  throw new Error(`no agent selected in workspace "${ws.name}"`);
}

/** Register the core commands; returns the combined unregister. */
export function registerCoreCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): () => void {
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
          panes: ws.panes.map((p, i) => ({
            id: p.id,
            title: paneDisplayTitle(p, i, agents),
            agentType: paneAgentType(p),
            branch: p.branch ?? null,
            cwd: p.cwd ?? ws.cwd,
            // Null when nothing reports — a pane that is provisioning,
            // stopped, or running a CLI with no status reporter. Absent
            // information, not an absent pane.
            activity: deps.activityOf(p.id) ?? null,
            // Who this agent is on the team, when it is on one. The roster
            // is where an agent learns the roles it may write to, so the
            // field is here rather than behind a command of its own.
            team: teamOf(p),
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
        return { workspaceId: workspace.id, paneId: pane.id };
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
          name: "agentType",
          type: "string",
          description: "Agent id from the catalog (claude, codex, opencode)",
        },
        { name: "name", type: "string", description: "Pane name" },
        {
          name: "task",
          type: "string",
          description: "Initial prompt, typed into the agent once it starts",
        },
      ],
      run: async (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        // Declared required — read as required, so a blank one is refused
        // instead of quietly meaning "the active workspace".
        const ws = targetWorkspace(deck, requiredStr(args, "workspace"));
        const workspace = { id: ws.id, instance: ws.instance };
        const currentTarget = (): { deck: Deck; workspace: Workspace } => {
          const currentDeck = deps.deck();
          const currentWorkspace = findWorkspaceByRef(
            currentDeck.workspaces,
            workspace,
          );
          if (!currentWorkspace) {
            throw new Error(WORKSPACE_GONE_MESSAGE);
          }
          return { deck: currentDeck, workspace: currentWorkspace };
        };
        const requested = str(args, "agentType");
        if (requested && !agents.some((a) => a.id === requested))
          throw new Error(`unknown agent type "${requested}"`);
        const agentType = requested ?? nextAgentType(agents, ws);
        if (!agentSupportsNew(agents, agentType)) {
          throw new Error(
            `agent type "${agentType}" does not support new sessions`,
          );
        }
        const id = paneId(mintAgentSeq());
        const index = nextAgentIndex(ws);

        // The global YOLO default reaches this surface too, gated on the
        // resolved agent's support like every other creation path.
        const yolo =
          (getSettings()?.defaultYolo ?? false) &&
          agentSupportsYolo(agents, agentType);
        // Location mirrors the "+ Agent" dialog's defaults: a repo workspace
        // with a base folder gets the first FREE worktree suggestion (never a
        // dir an open pane holds, nor one blocked on disk); anything else
        // runs in the workspace cwd.
        let pane: Pane = {
          id,
          name: str(args, "name"),
          agentType,
          ...(yolo && { yolo: true }),
        };
        const info = await inspectRepo(ws.cwd).catch(() => null);
        let current = currentTarget();
        if (info?.isRepo) {
          const free = await firstFreeAgentWorktree(
            current.deck.workspaces,
            current.workspace,
            index,
          );
          current = currentTarget();
          if (free) {
            pane = {
              ...pane,
              provisioning: {
                repo: current.workspace.cwd,
                path: free.path,
                branch: free.branch,
                workspace: current.workspace.name,
                index,
              },
            };
          }
        }

        // A full workspace used to swallow the add and then report a paneId
        // that was never in the deck — with the worktree already created. The
        // `never` is what makes a new refusal a compile error here: a bare
        // switch would let an unmatched outcome fall straight through to the
        // success report below.
        const landed = deps.createPane({ workspace, pane });
        switch (landed.kind) {
          case "created":
            break;
          case "full":
            throw new Error(WORKSPACE_FULL_MESSAGE);
          case "gone":
            throw new Error(WORKSPACE_GONE_MESSAGE);
          default: {
            const unhandled: never = landed;
            throw new Error(
              `unhandled create outcome: ${JSON.stringify(unhandled)}`,
            );
          }
        }
        current = currentTarget();
        current.deck.selectWorkspace(workspace.id);
        current.deck.selectPane(workspace.id, id);

        const task = str(args, "task");
        if (task) void deliverTask(id, task);
        return {
          paneId: id,
          workspaceId: workspace.id,
          agentType,
          worktree: pane.provisioning
            ? { path: pane.provisioning.path, branch: pane.provisioning.branch ?? null }
            : null,
          task: task ? "scheduled" : "none",
        };
      },
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
