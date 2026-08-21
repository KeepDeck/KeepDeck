import { useRef } from "react";
import { workspaceScopeDirectories } from "../domain/deck/roots";
import type { Workspace } from "../domain/deck/workspaces";
import type { SessionRecord } from "../domain/journal";

/** The fingerprint of a scope — DERIVED FROM THE RULE'S RESULT, so the
 * key and the rule cannot drift apart by construction: change what the
 * rule counts in, and the fingerprint changes with it. Sorted so the
 * same membership in any insertion order is the same fingerprint. */
function scopeFingerprint(dirs: ReadonlySet<string>): string {
  return [...dirs].sort().join("\u0000");
}

/**
 * The workspace-scope policy's APPLICATION-side seat: identity-stable
 * directory set for a workspace, a SEMANTIC version of the scope.
 *
 * The RULE lives in the domain (`workspaceScopeDirectories` — one
 * address); IDENTITY STABILITY lives here, in the application layer,
 * because it is a rendering concern: the scope-change effect downstream
 * answers a new set identity with a page reset, so a fresh Set for an
 * UNCHANGED scope would blank the screen and re-ask the index (~1s)
 * for a question it has already answered.
 *
 * The stability is SEMANTIC over BOTH inputs, not referential over
 * either: the same CONTENT returns the SAME Set object, whatever arrays
 * or workspace objects carried it in — the journal (the rows) AND the
 * workspace (its cwd and panes) are each read by content, so a journal
 * event in ANOTHER workspace rebuilds the deck's arrays without moving
 * this scope, and a fresh workspace object per render is harmless. A
 * real change of content — from either input — produces a new Set: the
 * journal's late arrival on a cold start is a REAL scope change (the
 * page-zero-reset disease), and so is a pane folder appearing. The
 * version check is the RULE'S OWN RESULT fingerprinted — not a parallel
 * formula over raw inputs, which could know about folders the rule
 * stopped counting (or miss ones it started counting: an empty journal
 * cwd is dropped by the rule and by the fingerprint alike, a
 * provisioning pane's unresolved cwd likewise). The contract the
 * CONSUMER gets is one identity per scope version; the caller owes
 * nothing but honest data.
 */
export function useWorkspaceScope(
  ws: Pick<Workspace, "id" | "cwd" | "panes">,
  records: SessionRecord[],
): ReadonlySet<string> {
  const next = workspaceScopeDirectories(ws, records.map((r) => r.cwd));

  // The ref holds the LAST result together with its fingerprint — the
  // recomputation above is the rule's own truth; the fingerprint only
  // decides whether to hand out a fresh identity.
  const lastRef = useRef<{ fp: string; dirs: ReadonlySet<string> } | null>(null);
  const fp = scopeFingerprint(next);
  if (lastRef.current === null || lastRef.current.fp !== fp) {
    lastRef.current = { fp, dirs: next };
  }
  return lastRef.current.dirs;
}
