import { useEffect, useRef } from "react";
import { defaultAgentType, type AgentInfo } from "../domain/agents";
import {
  resolvePaneRef,
  resolveWorkspaceRef,
  type CommandArgs,
  type CommandRegistry,
} from "../domain/commands";
import {
  firstFreeWorktree,
  paneDisplayTitle,
  paneId,
  type Pane,
  type Workspace,
} from "../domain/deck";
import { inspectRepo, probeWorktree, suggestWorktree } from "../ipc/worktree";
import { commands } from "./commandRegistry";
import { mintAgentSeq } from "./ids";
import { paneInputReady, writeToPane } from "./paneInput";
import { provisionInto, runProvisioning } from "./provisioning";
import { getSettings } from "./settingsManager";
import type { Deck } from "./useDeck";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. Handlers
 * read the CURRENT deck through accessors, exactly like the plugin deck
 * bridge: the registration happens once, the deck it acts on is always this
 * render's.
 */
export interface CoreCommandDeps {
  deck(): Deck;
  agents(): AgentInfo[];
  /** Open the close-confirm flow — voice/MCP closes go through the same
   * dialog as ⌘W, so the destructive step keeps its human confirmation. */
  requestCloseAgent(wsId: string, paneId: string, label: string): void;
}

/** How long task delivery waits for the pane's PTY writer to appear (a
 * worktree create + CLI start can take a while), then for the CLI to start
 * accepting input. Readiness = "the input writer exists" is an MVP heuristic
 * — replaced by a real CLI-ready signal when one exists. */
const TASK_POLL_MS = 200;
const TASK_POLL_TRIES = 300;
const TASK_SETTLE_MS = 1500;

/** Deliver a spawn's initial task into the pane once its session is live.
 * Fire-and-forget from the spawn handler: the spawn's outcome is the pane,
 * not the task. Returns whether the text was written. */
export async function deliverTask(
  paneIdToWrite: string,
  text: string,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  for (let i = 0; i < TASK_POLL_TRIES && !paneInputReady(paneIdToWrite); i++) {
    await wait(TASK_POLL_MS);
  }
  if (!paneInputReady(paneIdToWrite)) return false;
  await wait(TASK_SETTLE_MS);
  return writeToPane(paneIdToWrite, text + "\r");
}

function str(args: CommandArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The workspace a command acts on: the named one, else the active one. */
function targetWorkspace(deck: Deck, ref: string | undefined): Workspace {
  if (ref) {
    const resolved = resolveWorkspaceRef(deck.workspaces, ref);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.value;
  }
  const active = deck.workspaces.find((w) => w.id === deck.activeId);
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
            agentType: p.agentType ?? "claude",
            branch: p.branch ?? null,
            cwd: p.cwd ?? ws.cwd,
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
        const ws = targetWorkspace(deck, str(args, "workspace"));
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
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const requested = str(args, "agentType");
        if (requested && !agents.some((a) => a.id === requested))
          throw new Error(`unknown agent type "${requested}"`);
        const agentType =
          requested ??
          defaultAgentType(
            agents,
            ws.panes[ws.panes.length - 1]?.agentType ??
              getSettings()?.defaultAgent ??
              "claude",
          );
        const id = paneId(mintAgentSeq());
        const index = ws.panes.length + 1;

        // Location mirrors the "+ Agent" dialog's defaults: a repo workspace
        // with a base folder gets the first FREE worktree suggestion (never a
        // dir an open pane holds, nor one blocked on disk); anything else
        // runs in the workspace cwd.
        let pane: Pane = { id, name: str(args, "name"), agentType };
        const info = await inspectRepo(ws.cwd).catch(() => null);
        if (info?.isRepo && ws.worktreeBaseDir) {
          const free = await firstFreeWorktree(
            deck.workspaces,
            ws.worktreeBaseDir,
            (i) => suggestWorktree(ws.name, i).catch(() => null),
            index,
            (path) => probeWorktree(path).catch(() => null),
          );
          if (free) {
            pane = {
              ...pane,
              provisioning: {
                repo: ws.cwd,
                path: free.path,
                branch: free.branch,
                workspace: ws.name,
                index,
              },
            };
          }
        }

        deck.addAgentPane(ws.id, pane);
        if (pane.provisioning)
          void runProvisioning([pane], provisionInto(deck, ws.id));
        deck.selectWorkspace(ws.id);
        deck.selectPane(ws.id, id);

        const task = str(args, "task");
        if (task) void deliverTask(id, task);
        return {
          paneId: id,
          workspaceId: ws.id,
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
        const pane = targetPane(deck, deps.agents(), ws, str(args, "agent"));
        deck.selectWorkspace(ws.id);
        deck.selectPane(ws.id, pane.id);
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
      destructive: true,
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
      id: "pane.write",
      title: "Type text into an agent pane",
      args: [
        { name: "text", type: "string", required: true, description: "Text to type" },
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
      ],
      run: (args) => {
        const deck = deps.deck();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, deps.agents(), ws, str(args, "agent"));
        const text = args.text as string;
        const written = writeToPane(
          pane.id,
          args.submit === true ? text + "\r" : text,
        );
        if (!written) throw new Error("the pane has no live session");
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Wire the core commands to the live deck — the composition root's hook.
 * Registration happens once; the accessors always read the current render's
 * deck through the ref (the plugin deck bridge's idiom). */
export function useCoreCommands(deps: {
  deck: Deck;
  agents: AgentInfo[];
  requestCloseAgent(wsId: string, paneId: string, label: string): void;
}): void {
  const ref = useRef(deps);
  ref.current = deps;
  useEffect(
    () =>
      registerCoreCommands(commands, {
        deck: () => ref.current.deck,
        agents: () => ref.current.agents,
        requestCloseAgent: (wsId, paneIdToClose, label) =>
          ref.current.requestCloseAgent(wsId, paneIdToClose, label),
      }),
    [],
  );
}
