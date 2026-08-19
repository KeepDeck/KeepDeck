import { useRef } from "react";
import { workspaceScopeDirectories } from "../domain/deck/roots";
import type { Workspace } from "../domain/deck/workspaces";
import type { SessionRecord } from "../domain/journal";

/**
 * The workspace-scope policy's APPLICATION-side seat: identity-stable
 * directory set for a workspace, a SEMANTIC version of the scope.
 *
 * The RULE lives in the domain (`workspaceScopeDirectories` — one
 * address); IDENTITY STABILITY lives here, in the application layer,
 * because it is a rendering concern: the scope-change effect downstream
 * answers a new set identity with a page reset, so a fresh Set for an
 * UNCHANGED scope would blank the screen and re-ask the index (~1s) for
 * a question it has already answered.
 *
 * The stability here is SEMANTIC over BOTH inputs, not referential over
 * either: the same CONTENT returns the SAME Set object, whatever arrays
 * or workspace objects carried it in — the journal (the rows) AND the
 * workspace (its cwd and panes) are each read by content, so a journal
 * event in ANOTHER workspace rebuilds the deck's arrays without moving
 * this scope, and a fresh workspace object per render is harmless. A
 * real change of content — from either input — produces a new Set: the
 * journal's late arrival on a cold start is a REAL scope change (the
 * page-zero-reset disease commit 1 treats), and so is a pane folder
 * appearing. The contract the CONSUMER gets is one identity per scope
 * version; the caller owes nothing but honest data.
 */
export function useWorkspaceScope(
  ws: Pick<Workspace, "id" | "cwd" | "panes">,
  records: SessionRecord[],
): ReadonlySet<string> {
  const cwds = records.map((r) => r.cwd);
  const dirList = [...new Set(cwds)].sort();
  const panesCwd = ws.panes
    .map((p) => p.cwd ?? ws.cwd)
    .filter((c) => c !== undefined) as string[];
  const key = JSON.stringify([ws.cwd, [...new Set(panesCwd)].sort(), dirList]);

  const lastRef = useRef<{ key: string; dirs: ReadonlySet<string> } | null>(null);
  if (lastRef.current === null || lastRef.current.key !== key) {
    lastRef.current = { key, dirs: workspaceScopeDirectories(ws, cwds) };
  }
  return lastRef.current.dirs;
}
