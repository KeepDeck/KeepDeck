/**
 * The agent dialog's request, as the lifecycle is asked it: where the team
 * runs (a [`Site`]) and the agent the person shaped (an [`AgentDraft`]). The
 * dialog collects; these read it once, so no door reads the form its own way.
 */
import type { AgentDialogResult, DirectoryState } from "../agents";
import type { PaneDraft } from "./drafts";
import type { Claim, Site } from ".";

/** The teams the machine's claims on a folder name — who works there. */
export function claimingTeams(claims: readonly Claim[]): string[] {
  return claims.flatMap((claim) => (claim.kind === "team" ? [claim.team] : []));
}

/** A folder as the dialog's location field reads the machine's claims on
 * it: held while a worktree is made or removed there — that outranks a team
 * on it — worked in while a team is, free otherwise. A session running there
 * holds nothing the field asks about. */
export function directoryStateOf(claims: readonly Claim[]): DirectoryState {
  if (claims.some((claim) => claim.kind === "creation" || claim.kind === "removal")) return "held";
  return claims.some((claim) => claim.kind === "team") ? "worked-in" : "free";
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

/** The fresh agent one dialog request describes — sparse, as persistence
 * keeps a pane: only what is set. A remote agent carries its endpoint. */
export function agentDraftFromRequest(agentType: string, request: AgentDialogResult): AgentDraft {
  const name = request.name.trim();
  return {
    agentType,
    ...(name && { name }),
    ...(request.yolo && { yolo: true }),
    ...(request.remoteEndpoint && { location: { kind: "remote", endpoint: request.remoteEndpoint } }),
  };
}
