import type { AgentInfo } from "../agents";
import type { Pane, Workspace } from "../deck";
import { paneDisplayTitle } from "../deck";

/** Command-layer resolution outcome: a value or a human-readable refusal.
 * Refusals become `failed` command errors verbatim, so they are written for
 * the caller's eyes (a voice history line, an MCP tool error). */
export type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Resolve a workspace reference — an exact id first, else a case-insensitive
 * name match. External callers address workspaces by what they see (the
 * name); ids serve programmatic callers reading `workspace.list`. Ambiguity
 * is a refusal, not a guess: with two workspaces named "web", a spawn must
 * not land in either at random. Pure.
 */
export function resolveWorkspaceRef(
  workspaces: Workspace[],
  ref: string,
): Resolved<Workspace> {
  const byId = workspaces.find((w) => w.id === ref);
  if (byId) return { ok: true, value: byId };
  const needle = ref.trim().toLowerCase();
  const named = workspaces.filter((w) => w.name.toLowerCase() === needle);
  if (named.length === 1) return { ok: true, value: named[0] };
  return {
    ok: false,
    message:
      named.length === 0
        ? `no workspace "${ref}"`
        : `workspace name "${ref}" is ambiguous`,
  };
}

/**
 * Resolve a pane inside `ws` — an exact pane id first, else a
 * case-insensitive match on the pane's display title (what the header shows,
 * e.g. "Claude 2") or its user-given name. Same no-guessing rule as
 * workspaces. Pure.
 */
export function resolvePaneRef(
  ws: Workspace,
  agents: AgentInfo[],
  ref: string,
): Resolved<Pane> {
  const byId = ws.panes.find((p) => p.id === ref);
  if (byId) return { ok: true, value: byId };
  const needle = ref.trim().toLowerCase();
  const matched = ws.panes.filter(
    (p, i) =>
      paneDisplayTitle(p, i, agents).toLowerCase() === needle ||
      p.name?.toLowerCase() === needle,
  );
  if (matched.length === 1) return { ok: true, value: matched[0] };
  return {
    ok: false,
    message:
      matched.length === 0
        ? `no agent "${ref}" in workspace "${ws.name}"`
        : `agent "${ref}" is ambiguous in workspace "${ws.name}"`,
  };
}
