/**
 * Resolving what a command was aimed AT: the workspace, the pane, and the two
 * facts a report says about a team. Shared by every command module, and
 * nothing else — the doors differ in what they do, not in how they find it.
 */
import {
  type AgentInfo,
} from "../../domain/agents";
import {
  resolvePaneRef,
  resolveWorkspaceRef,
} from "../../domain/commands";
import {
  findWorkspace,
  type Pane,
  type Team,
  type Workspace,
  paneProvisioning,
} from "../../domain/deck";
import type { Deck } from "../useDeck";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. The plain
 * application controller registers once; accessors read the current store and
 * current UI port for every invocation. This is the STATIC registration
 * lifecycle; feature-gated command sets have their own register/dispose
 * lifecycle. The split is deliberate: a feature toggle must not re-register
 * or tear down the core set.
 */

export const DIALOG_BUSY_MESSAGE =
  "Another dialog is open — close it before opening this one";


/** The workspace a command acts on: the named one, else the active one. */
/** The worktree a freshly recruited pane is heading for, as the recruit
 * answer reports it — or null once (or when) there is no create in flight. */
export function worktreeAhead(
  ws: Workspace,
  pane: Pane,
): { path: string; branch: string | null } | null {
  const card = paneProvisioning(ws, pane);
  return card ? { path: card.intent.path, branch: card.intent.branch ?? null } : null;
}

/** A team's state, folded to one word for a roster reader: its worktree
 * still being created, the create failed (Retry is on offer), or ready. */
export function teamStatus(team: Team): "creating" | "failed" | "ready" {
  if (team.location?.kind !== "provisioning") return "ready";
  return team.location.error !== undefined ? "failed" : "creating";
}

export function targetWorkspace(deck: Deck, ref: string | undefined): Workspace {
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

export function targetPane(
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
