import { useMemo } from "react";
import { workspaceScopeDirectories } from "../domain/deck/roots";
import type { Workspace } from "../domain/deck/workspaces";
import type { SessionRecord } from "../domain/journal";

/**
 * The workspace-scope policy's APPLICATION-side seat: identity-stable
 * directory set for a workspace, recomputed only when its inputs move.
 *
 * The RULE lives in the domain (`workspaceScopeDirectories` — one
 * address); IDENTITY STABILITY lives here, in the application layer,
 * because it is a rendering concern: a fresh Set per render would churn
 * the scope key downstream and re-ask the index for an unchanged
 * question. The inputs are raw data (the workspace, its journal rows),
 * so the memo compares them structurally — a new array with the same
 * rows keeps the identity, and the journal's late arrival on a cold
 * start correctly produces a new one (a REAL scope change, the
 * commit-1 disease, not churn).
 */
export function useWorkspaceScope(
  ws: Pick<Workspace, "id" | "cwd" | "panes">,
  records: SessionRecord[],
): ReadonlySet<string> {
  const cwds = useMemo(() => records.map((r) => r.cwd), [records]);
  const dirs = useMemo(
    () => workspaceScopeDirectories(ws, cwds),
    [ws.cwd, ws.panes, cwds],
  );
  return dirs;
}
