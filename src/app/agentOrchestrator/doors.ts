/**
 * The orchestrator's lifecycle doors. Making, closing, suspending, resuming,
 * archiving, restoring, restarting, continuing a session, moving a member:
 * each is one intent to the lifecycle machine, and nothing else. What the
 * machine does after reaches the deck as its commands; the page drafts what
 * the person chose and mints the ids of what it asks to be made, and reads
 * the answer as an [`IntentOutcome`].
 *
 * One thing stays the page's at the door: a reference that outlived its
 * workspace's lifetime reaches nothing — the machine knows ids, and only the
 * page knows which lifetime a stale dialog was opened against.
 */
import type { ForkTarget } from "../../domain/agents";
import {
  findPane,
  findWorkspace,
  findWorkspaceByRef,
  landingTeamName,
  nextAutoTeamName,
  paneResumeBlock,
  paneSuspendRefusal,
  sameDirectory,
  teamIdsOf,
  teamsOf,
  workspaceName,
  worktreeBaseDirOf,
  type TeamActFacts,
  type TeamActs,
  type Workspace,
} from "../../domain/deck";
import type { AgentDraft, IntentOutcome, PaneDraft, ResumeOutcome, Site } from "../../domain/lifecycle";
import type { SessionHandle } from "../../domain/journal";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import type { Landing } from "../../ipc/generated/lifecycle/Landing";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { mintTeamId, mintWorkspaceId } from "../ids";
import type { ContinuationPlans } from "../lifecycle/continuationPlans";
import { intentOutcomeOf } from "../lifecycle/outcome";
import type {
  AgentOrchestrator,
  ContinueOptions,
  CreatePaneRequest,
  CreateTeamRequest,
  TranscriptLocatorPort,
} from ".";

export interface LifecycleDoorsDeps {
  deck: DeckStore;
  actions: DeckActions;
  send(intent: Intent): Promise<Reply>;
  /** Note what a continued session's plan is built from, before its intent
   * goes. */
  continuations: Pick<ContinuationPlans, "expect">;
  transcripts: TranscriptLocatorPort;
  teamActs(wsId: string, teamId: string): TeamActs | null;
  /** What a pane's Suspend and Resume read beyond the deck — the ones a
   * team's acts read: the funnel's folder verdict, the catalog, and whether
   * the machine is suspending it. */
  facts: TeamActFacts;
  /** Panes the person asked back: their old notes go and a start is owed. */
  askedBack(paneIds: readonly string[]): void;
  /** A restart the machine took on: the funnel owes the pane its next
   * process, on its recorded session or fresh. */
  restarting(paneId: string, resume: boolean): void;
  /** A start fresh that did not go ahead: the pane keeps what it had, and
   * its card says why. */
  startRefused(paneId: string, outcome: Exclude<IntentOutcome, { kind: "accepted" }>): void;
}

export type LifecycleDoors = Pick<
  AgentOrchestrator,
  | "createPane"
  | "createTeam"
  | "createWorkspace"
  | "retryProvisioning"
  | "suspend"
  | "suspendTeam"
  | "close"
  | "archive"
  | "restore"
  | "restart"
  | "resumeSession"
  | "forkSession"
  | "startFresh"
  | "resume"
  | "resumeTeam"
>;

/** A reference that outlived its workspace's lifetime. */
const GONE: IntentOutcome = { kind: "refused", refusal: { kind: "notFound" } };

/** The team already working at `site` in `ws`, the one a new agent joins. */
function teamAt(ws: Workspace, site: Site): string | null {
  const cwd = site.kind === "root" ? ws.cwd : site.kind === "existing" ? site.cwd : null;
  if (cwd === null) return null;
  const holder = teamsOf(ws).find((team) => team.location?.kind === "attached" && sameDirectory(team.location.cwd, cwd));
  return holder?.id ?? null;
}

function draftOf(agent: AgentDraft, role: string, session?: string): PaneDraft {
  return {
    agentType: agent.agentType,
    role,
    ...(agent.name?.trim() && { name: agent.name.trim() }),
    ...(agent.yolo && { yolo: true }),
    ...(agent.location && { location: agent.location }),
    ...(session !== undefined && { session: { id: session } }),
  };
}

export function createLifecycleDoors(deps: LifecycleDoorsDeps): LifecycleDoors {
  const workspaces = () => deps.deck.getSnapshot().workspaces;
  const lifetime = (ref: WorkspaceRef) => findWorkspaceByRef(workspaces(), ref);
  const ask = async (intent: Intent): Promise<IntentOutcome> => intentOutcomeOf(await deps.send(intent));
  const newTeamId = () => mintTeamId(teamIdsOf(workspaces()));

  /** The landing a new member of `ws` takes: the team it names, the team at
   * its site, or a new team made there under `name`. */
  function landingOf(ws: Workspace, team: string | undefined, site: Site, name: string | undefined): Landing {
    const joined = team ?? teamAt(ws, site);
    if (joined) return { kind: "team", team: joined };
    return { kind: "newTeam", team: newTeamId(), site, draft: { name: landingTeamName(ws, name) } };
  }

  async function createPane(request: CreatePaneRequest): Promise<IntentOutcome> {
    const ws = lifetime(request.workspace);
    if (!ws) return GONE;
    const member = draftOf(request.pane, request.role);
    const landing = landingOf(ws, request.team, request.site ?? { kind: "root" }, request.teamName ?? request.pane.name);
    return landing.kind === "team"
      ? ask({ kind: "seat", workspace: ws.id, team: landing.team, member })
      : ask({ kind: "createTeam", workspace: ws.id, team: landing.team, site: landing.site, draft: landing.draft, members: [member] });
  }

  async function createTeam(request: CreateTeamRequest): Promise<IntentOutcome> {
    const ws = lifetime(request.workspace);
    if (!ws) return GONE;
    const name = request.name.trim() || nextAutoTeamName(ws);
    return ask({ kind: "createTeam", workspace: ws.id, team: newTeamId(), site: request.site, draft: { name }, members: [] });
  }

  /** A journal session continued into a new pane of `wsId`. */
  async function continueSession(
    wsId: string,
    record: SessionHandle,
    how: "resume" | "fork",
    site: Site,
    opts: ContinueOptions,
  ): Promise<IntentOutcome> {
    const ws = findWorkspace(workspaces(), wsId);
    if (!ws) return GONE;
    const yolo = opts.yolo ?? record.yolo;
    const member = draftOf(
      { agentType: record.agent, name: opts.name, yolo },
      opts.role,
      how === "resume" ? record.sessionId : undefined,
    );
    // The file a fork copies: what the binding reported, else what the
    // plugin declared to the index. Still unknown is the plugin's to refuse
    // — a fork that needs no file goes on without it.
    const transcriptPath =
      how === "fork" ? (record.transcriptPath ?? (await deps.transcripts.locateTranscript(record.agent, record.sessionId)) ?? undefined) : undefined;
    const source = { agent: record.agent, session: record.sessionId };
    deps.continuations.expect(ws.id, source, {
      workspace: { id: ws.id, instance: ws.instance },
      cwd: record.cwd,
      ...(record.branch !== undefined && { branch: record.branch }),
      ...(yolo !== undefined && { yolo }),
      ...(transcriptPath !== undefined && { transcriptPath }),
    });
    return ask({
      kind: "continue",
      workspace: ws.id,
      landing: landingOf(ws, opts.team, site, opts.name),
      source,
      how,
      member,
    });
  }

  /** Ask one stopped pane back. A suspended pane is the machine's to bring
   * back; one parked by the launch policy, or whose wake failed, rises by
   * the page's own ask, as wake and park always were. */
  async function resumeOne(wsId: string, paneId: string): Promise<ResumeOutcome> {
    const ws = findWorkspace(workspaces(), wsId);
    const pane = ws?.panes.find((candidate) => candidate.id === paneId);
    if (!ws || !pane) return { kind: "blocked", why: "gone" };
    const block = paneResumeBlock(ws, pane, deps.facts.agentAvailable(pane.agentType));
    if (block) return { kind: "blocked", why: block };
    // The old notes go and a start is owed BEFORE the pane can rise: the
    // machine's command may reach the deck, and the funnel act on it, before
    // its answer here does — a note cleared after would erase the verdict of
    // the very attempt this ask started.
    deps.askedBack([paneId]);
    if (pane.idle?.reason === "suspended") {
      const outcome = await ask({ kind: "resume", workspace: wsId, pane: paneId });
      if (outcome.kind !== "accepted") return outcome;
    } else {
      deps.actions.requestPanesWake(wsId, [paneId]);
    }
    return { kind: "resuming" };
  }

  return {
    createPane,
    createTeam,
    async createWorkspace(config) {
      const cwd = config.cwd.trim();
      const name = workspaceName(config.name, cwd);
      const base = worktreeBaseDirOf(config.worktreeBaseDir);
      return ask({
        kind: "createWorkspace",
        workspace: mintWorkspaceId(new Set(workspaces().map((ws) => ws.id))),
        name,
        cwd,
        worktreeBase: base,
        draft: { name, cwd, worktreeBaseDir: base },
      });
    },
    retryProvisioning: (wsId, teamId) => ask({ kind: "retry", workspace: wsId, team: teamId }),
    /** Stop one pane and keep it. What the page can tell refuses it now —
     * the same refusal a team's Suspend reads for each member — is said in
     * the deck's own terms; the rest is the machine's to decide. */
    async suspend(wsId, paneId) {
      const ws = findWorkspace(workspaces(), wsId);
      const pane = ws?.panes.find((candidate) => candidate.id === paneId);
      if (!ws || !pane) return { kind: "blocked", why: "gone" };
      const refusal = paneSuspendRefusal(ws, pane, {
        blocked: deps.facts.blocked(paneId),
        suspending: deps.facts.suspending(paneId),
      });
      if (refusal) return { kind: "blocked", why: refusal };
      const outcome = await ask({ kind: "suspend", workspace: wsId, pane: paneId });
      return outcome.kind === "accepted" ? { kind: "suspending" } : outcome;
    },
    async suspendTeam(wsId, teamId, named) {
      const take = (deps.teamActs(wsId, teamId)?.suspend.take ?? []).filter((paneId) => named.includes(paneId));
      return Promise.all(take.map((paneId) => ask({ kind: "suspend", workspace: wsId, pane: paneId })));
    },
    async close(request) {
      const ws = lifetime(request.workspace);
      if (!ws) return GONE;
      switch (request.kind) {
        case "agent":
          return ask({ kind: "closeAgent", workspace: ws.id, pane: request.paneId, consent: request.consent });
        case "team":
          return ask({ kind: "disband", workspace: ws.id, team: request.teamId, consent: request.consent });
        case "workspace":
          return ask({ kind: "closeWorkspace", workspace: ws.id, consent: request.consent });
      }
    },
    async archive(ref) {
      const ws = lifetime(ref);
      return ws ? ask({ kind: "archive", workspace: ws.id }) : GONE;
    },
    async restore(ref) {
      const ws = lifetime(ref);
      return ws ? ask({ kind: "restore", workspace: ws.id }) : GONE;
    },
    async restart(wsId, paneId, mode) {
      const pane = findPane(workspaces(), wsId, paneId);
      if (!pane) return GONE;
      const outcome = await ask({ kind: "restart", workspace: wsId, pane: paneId });
      if (outcome.kind === "accepted") {
        // A fresh start forgets the conversation; a resume keeps it, and the
        // funnel builds its plan once the old process is over — a plan built
        // before would go with the stop's own retire.
        if (mode === "fresh") deps.actions.setPaneSession(wsId, paneId, null);
        deps.restarting(paneId, mode === "resume");
      }
      return outcome;
    },
    resumeSession: (wsId, record, opts) => continueSession(wsId, record, "resume", { kind: "existing", cwd: record.cwd }, opts),
    forkSession: (wsId, record, target: ForkTarget, opts) =>
      continueSession(
        wsId,
        record,
        "fork",
        target.kind === "dir"
          ? { kind: "existing", cwd: target.cwd }
          : { kind: "new", place: { path: target.path, branch: target.branch }, base: target.base ?? null },
        opts,
      ),
    async startFresh(wsId, paneId, role) {
      const ws = findWorkspace(workspaces(), wsId);
      if (!ws) return GONE;
      const root = teamAt(ws, { kind: "root" }) ?? newTeamId();
      const outcome = await ask({ kind: "relocate", workspace: wsId, pane: paneId, root, role: role ?? null });
      if (outcome.kind !== "accepted") {
        deps.startRefused(paneId, outcome);
        return outcome;
      }
      // A new conversation in the root: the pane rises again, by the
      // person's own ask.
      deps.askedBack([paneId]);
      deps.actions.requestPanesWake(wsId, [paneId]);
      return outcome;
    },
    resume: resumeOne,
    async resumeTeam(wsId, teamId) {
      const take = deps.teamActs(wsId, teamId)?.resume.take ?? [];
      return Promise.all(take.map((paneId) => resumeOne(wsId, paneId)));
    },
  };
}
