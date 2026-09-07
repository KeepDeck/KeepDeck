/**
 * How a command finds what it acts on: the workspace it names or the active
 * one, the pane it names or the selected one, and the worktree a recruit is
 * heading for. Asked by every area of the core set, answered once here —
 * two copies of "the active workspace" had already drifted before this
 * existed.
 */
import type { AgentInfo } from "../../domain/agents";
import { resolvePaneRef, resolveWorkspaceRef } from "../../domain/commands";
import { findWorkspace, type Pane, type Workspace, paneProvisioning } from "../../domain/deck";
import type { Deck } from "../useDeck";

/** The workspace a command acts on: the named one, else the active one. */
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

/** The pane a command acts on: the named one, else the selected one, else
 * the only one. */
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

/** The worktree a freshly recruited pane is heading for, as the recruit
 * answer reports it — or null once (or when) there is no create in flight. */
export function worktreeAhead(
  ws: Workspace,
  pane: Pane,
): { path: string; branch: string | null } | null {
  const card = paneProvisioning(ws, pane);
  return card ? { path: card.intent.path, branch: card.intent.branch ?? null } : null;
}
