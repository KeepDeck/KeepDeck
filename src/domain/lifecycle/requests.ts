/**
 * The agent dialog's request, as the lifecycle is asked it: where the team
 * runs (a [`Site`]) and the agent the person shaped (an [`AgentDraft`]). The
 * dialog collects; these read it once, so no door reads the form its own way.
 */
import type { AgentDialogResult } from "../agents";
import type { PaneDraft } from "./drafts";
import type { Claim, Site } from ".";

/** The teams the machine's claims on a folder name — who works there. */
export function claimingTeams(claims: readonly Claim[]): string[] {
  return claims.flatMap((claim) => (claim.kind === "team" ? [claim.team] : []));
}

/** A new agent as the person shaped it, before the role it takes on its
 * team and the session it may continue — both are the landing's. */
export type AgentDraft = Omit<PaneDraft, "role" | "session">;

/**
 * Where one dialog request asks its team to run: the workspace root, a
 * folder that exists, or a new worktree. A new worktree's place is the one
 * the form holds when it names both a folder and a branch; otherwise the
 * machine's next free place.
 */
export function siteFromAgentRequest(request: AgentDialogResult): Site {
  const { location } = request;
  // A remote agent's cwd is on its server's box: locally it is the root's.
  if (request.remoteEndpoint || location.kind === "main") return { kind: "root" };
  if (location.kind === "existing") return { kind: "existing", cwd: location.path };
  const path = location.path.trim();
  const branch = location.branch.trim();
  return {
    kind: "new",
    place: path && branch ? { path, branch } : null,
    base: location.baseBranch?.trim() || null,
  };
}

/** The fresh agent one dialog request describes, as it says it — a remote
 * agent with its endpoint. What is written of it, trimmed and sparse, is the
 * member's draft at the door (`draftOf`), the one every member passes. */
export function agentDraftFromRequest(agentType: string, request: AgentDialogResult): AgentDraft {
  return {
    agentType,
    name: request.name,
    yolo: request.yolo,
    ...(request.remoteEndpoint && { location: { kind: "remote", endpoint: request.remoteEndpoint } }),
  };
}
