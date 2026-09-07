import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentRemoteSchemes,
  agentSessionCapabilities,
  agentSupportsNew,
  agentSupportsYolo,
  canCreateAgent,
  remoteValid,
  canStartFromSession,
  selectableAgents,
  defaultAgentType as pickDefaultAgentType,
  type AgentDialogResult,
  type AgentDialogTarget,
  type AgentType,
  type DirectoryState,
  type PathProbe,
  type SessionPickRow,
  type SessionStartMode,
} from "../../domain/agents";
import { defaultRoleFor, mintRoleAddress, roleById, teamRoles } from "../../domain/mail";
import { rowKeyOf } from "../../domain/journal/sessionRow";
import { formatAge } from "../../domain/usage/format";
import { useAgents } from "../../app/useAgents";
import { useEscape } from "../../ui/useEscape";
import { noAutoCorrect } from "../../ui/inputProps";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { baseName } from "../../domain/deck";
import type { Page } from "../../app/usePagedSessionSearch";
import { useSessionPicker } from "./useSessionPicker";
import { WorktreeLocationField } from "./WorktreeLocationField";
import { useWorktreeLocation } from "./useWorktreeLocation";
import { Dropdown } from "../../ui/Dropdown";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { YoloField } from "../../ui/YoloField";

export type { AgentDialogResult } from "../../domain/agents";

interface AgentDialogProps {
  /** What the dialog is opened for: a new team, born with this agent (and
   * named here), or a member joining a team that exists — in that team's
   * directory, so no location is asked, and fresh only: a continuation
   * lands where its session was recorded, which is a team of its own. */
  target: AgentDialogTarget;
  /** The addresses the target team already holds — what the role picker
   * mints the new address against, and what tells it a singleton (the
   * lead) is already taken. Empty for a new team. */
  heldRoles: readonly string[];
  /** Pre-selected agent type. */
  defaultAgentType: AgentType;
  /** The YOLO toggle's starting position (the global preference); shown only
   * while the selected agent's plugin declares YOLO support. */
  defaultYolo: boolean;
  /** Whether the Experimental "Remote agents" setting is on — the "Where:
   *  Remote" option is hidden entirely unless this is true, regardless of an
   *  agent's declared capability. Required: every caller (App via the dialog
   *  spec, tests) states it explicitly so a forgotten pass can't silently
   *  hide remote. */
  remoteEnabled: boolean;
  /** The workspace repo, when its working dir is a git repo — enables the
   * worktree location field. Null → the agent just runs in the workspace cwd,
   * so there's no worktree choice to make and the field is hidden ([F2]). */
  repo: { cwd: string; branch: string | null } | null;
  /** Prefilled worktree path — non-empty only when the workspace has a base
   * folder set ([F2]: suggest a default only then, otherwise start empty =
   * main repo). Editable; empty means the agent runs in the main repo. */
  suggestedPath: string;
  /** Prefilled branch for a new worktree — the initial value of the live
   * branch suggestion (`branchForPath` keeps it following the path). */
  suggestedBranch: string;
  /** Probe a candidate worktree path for the live hint (injected — the dialog
   * itself stays free of IPC). */
  probePath(path: string): Promise<PathProbe>;
  /** The repo's local branches — the base-branch picker's options (injected).
   * A rejection degrades the picker to a free-text field: base validation
   * needs the list, so without one everything passes. */
  listBranches(repo: string): Promise<string[]>;
  /** The branch the current path implies — keeps the branch following the
   * worktree name while the user hasn't edited it. Null = no usable name
   * (the previous suggestion stays). */
  branchForPath(path: string): Promise<string | null>;
  /** What the deck says about a candidate path — see [`DirectoryState`].
   * Injected (the dialog stays free of deck state) and owned by the dialog's
   * hook, which knows which workspace is asking. */
  directoryAt(path: string): DirectoryState;
  /** The next suggested location not held by an open pane — the "Use next
   * available" action for an occupied or blocked path; null when none can be
   * offered. */
  nextFreeLocation(
    currentPath: string,
  ): Promise<{ path: string; branch: string } | null>;
  /** Native folder picker; null when cancelled. Injected for the same reason. */
  pickFolder(title: string): Promise<string | null>;
  /** One PAGE of an agent's sessions from the search index for the "Start
   * from" picker (newest first on an empty query, FTS-matched otherwise),
   * plus the full match count. Injected — the dialog stays free of IPC; the
   * dialog itself drives paging through the shared engine. */
  searchSessions(
    agent: AgentType,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<SessionPickRow>>;
  /** How a session is already held by a pane, for the resume dimming rule
   * — running, stopped, or free. Injected (deck state stays outside). */
  sessionClaim(sessionId: string): "running" | "stopped" | null;
  /** Which of the agent's sessions are held by an OUTSIDE process right
   * now (advisory, for the resume dimming rule): ids when the registry
   * answered, `ok: false` when it could not. Injected — the same seam the
   * session search uses; a view never touches a plugin. The answer lands
   * as a second wave, exactly like the branch list: opening stays instant. */
  liveOutside(
    agent: AgentType,
  ): Promise<{ ok: true; ids: ReadonlySet<string> } | { ok: false }>;
  onConfirm(result: AgentDialogResult): void;
  onCancel(): void;
}

/**
 * Modal behind "+ Team" and "Add member". The per-agent worktree/main choice is
 * DERIVED FROM THE PATH ([F2]), not a toggle: an empty "Worktree" field runs
 * the agent in the workspace's main repo; a path creates a new worktree there
 * (or attaches to an existing one). A live hint — modeled on the create
 * wizard's git-detected hint — says what the current path will do. The branch
 * follows the worktree's folder name until the user edits it (the ↺ reset
 * re-attaches it to the path). Agent type and location are per-agent, not
 * tied to the workspace; the type list is the detected install catalog ([F1]).
 */
export function AgentDialog({
  target,
  heldRoles,
  defaultAgentType,
  defaultYolo,
  remoteEnabled,
  repo,
  suggestedPath,
  suggestedBranch,
  probePath,
  listBranches,
  branchForPath,
  directoryAt,
  nextFreeLocation,
  pickFolder,
  searchSessions,
  sessionClaim,
  liveOutside,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [agentType, setAgentType] = useState<AgentType>(defaultAgentType);
  const [name, setName] = useState("");
  // The new team's name, seeded with the deck's own suggestion so the field
  // opens filled rather than empty-and-complaining; cleared, the suggestion
  // is what lands.
  const [teamName, setTeamName] = useState(
    target.kind === "new-team" ? target.suggestedName : "",
  );
  // The role — picked, never typed: it carries what the member is FOR, and
  // that only exists for a role the catalog has. Opens on what the deck
  // would give unasked: the lead where the team has none, else the next
  // implementer, or a peer among peers. The ADDRESS is minted from the pick
  // against the roster (`impl-2` past a held `impl-1`); a singleton the
  // team already holds mints nothing, and the form says so.
  const [roleId, setRoleId] = useState(() => defaultRoleFor(heldRoles).id);
  const roleOptions = useMemo(
    () => teamRoles().map((role) => ({ value: role.id, label: role.label })),
    [],
  );
  const pickedRole = roleById(roleId);
  const roleAddress = pickedRole ? mintRoleAddress(pickedRole, heldRoles) : null;
  // The toggle's state survives switching through a non-supporting agent —
  // only the SUBMITTED value is gated (see `supportsYolo` below).
  const [yolo, setYolo] = useState(defaultYolo);
  // WHERE the team runs — its own feature, with its own mind and its own
  // four async collaborators ([`useWorktreeLocation`]).
  const location = useWorktreeLocation({
    repo,
    suggestedPath,
    suggestedBranch,
    probePath,
    listBranches,
    branchForPath,
    directoryAt,
    nextFreeLocation,
    pickFolder,
  });
  // "Start from" ([F8] spawn-time continuation): fresh conversation, resume,
  // or fork of one of the SELECTED agent's indexed sessions.
  const [startMode, setStartMode] = useState<SessionStartMode>("new");
  // "Where" — run locally (default) or against a remote native-server
  // endpoint. `remote` survives switching to a non-supporting agent; only
  // the SUBMITTED value is gated (see `canRemote`). Remote is fresh-session
  // only for now: the local worktree is moot when the agent's brain is on
  // the box, so the Worktree + Start-from sections hide while it's on.
  const [where, setWhere] = useState<"local" | "remote">("local");
  const [endpoint, setEndpoint] = useState("");
  // What the Name field was last prefilled with (a picked session's title):
  // while name === prefill the field is untouched and follows the picks,
  // an edit detaches it — SuggestedInput's state machine, hand-rolled.
  const prefillRef = useRef("");
  const { agents } = useAgents();
  const agentOptions = selectableAgents(agents);
  const supportsNew = agentSupportsNew(agents, agentType);
  const {
    resume: supportsResume,
    fork: supportsFork,
  } = agentSessionCapabilities(agents, agentType);
  // The two things this dialog is for. A NEW TEAM is a name and a directory
  // and no agent yet — none of the agent fields below exist for it. A
  // MEMBER joins the team's directory: no location to choose, and a
  // continuation only while that directory is there (a create still out
  // has nothing to resume in or fork into).
  const forTeam = target.kind === "new-team";
  const member = target.kind === "member" ? target : null;
  const continuations = member !== null && member.cwd !== null;
  const startModeOptions: readonly (readonly [
    mode: SessionStartMode,
    label: string,
  ])[] = [
    ...(supportsNew ? ([["new", "New session"]] as const) : []),
    ...(continuations && supportsResume ? ([["resume", "Resume"]] as const) : []),
    ...(continuations && supportsFork ? ([["fork", "Fork"]] as const) : []),
  ];
  useEscape(onCancel);

  // A continuation mode belongs to the selected agent's live adapter. Agent
  // switches (or a contribution disappearing) must not leave an unsupported
  // mode selected behind a hidden button.
  useEffect(() => {
    if (
      (startMode === "resume" && !supportsResume) ||
      (startMode === "fork" && !supportsFork)
    ) {
      setStartMode("new");
    }
  }, [startMode, supportsResume, supportsFork]);

  // Prefill the Name from a session title while the field is UNTOUCHED (name
  // still equals the last prefill); a hand-edited name stays the user's. The
  // previous prefill is captured BEFORE reassigning the ref — setName's updater
  // runs later, by which point prefillRef.current would already be `next`.
  const applyPrefill = (next: string) => {
    const previous = prefillRef.current;
    setName((current) => (current === previous ? next : current));
    prefillRef.current = next;
  };

  // "Start from" — which recorded session this pane continues, and whether
  // it may. Its own feature, with its own four collaborators.
  const picker = useSessionPicker({
    agentType,
    startMode,
    member,
    searchSessions,
    sessionClaim,
    liveOutside,
    onPrefill: applyPrefill,
  });
  const {
    sessionQuery,
    setSessionQuery,
    picked,
    pagedSessions,
    sessions,
    listRef,
    onSessionsScroll,
    resumeBlockOf,
    blockReason,
    pickSession,
  } = picker;

  // Snap the pre-selected type onto the installed set once detection resolves
  // (the default may have been a not-installed fallback) ([F1]).
  useEffect(() => {
    if (agentOptions.length && !agentOptions.some((a) => a.id === agentType)) {
      setAgentType(pickDefaultAgentType(agents));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  const supportsYolo = agentSupportsYolo(agents, agentType);
  // The schemes the selected agent speaks (codex ws/wss, opencode http/https)
  // — null when the agent is local-only OR declares remote with no schemes.
  // canRemote keys off this (not just supportsRemote) so a malformed empty-
  // schemes declaration doesn't dangle a "Remote" option whose Create can
  // never enable.
  const remoteSchemes = agentRemoteSchemes(agents, agentType);
  // Remote needs BOTH the experimental setting on AND the agent declaring
  // non-empty schemes — so a default install (setting off) never shows the
  // option, and a non-remote/malformed agent never gets a target either.
  const canRemote = remoteEnabled && remoteSchemes !== null;
  // `remote` is only on while the selected agent can honor it; switching to a
  // non-remote agent silently drops it (the Where section hides), and the
  // submitted value is gated here so an unsupported agent never gets a target.
  const remote = where === "remote" && canRemote;
  const endpointOk = remoteValid(endpoint, remote ? remoteSchemes : null);
  const { kind, baseOk } = location;
  // A pick is only usable for the CURRENTLY selected agent. Switching agents
  // clears `picked`, but a click on a row still showing from the previous
  // agent (during the search's debounce window) can set a cross-agent handle;
  // narrow it to null so it can't be resumed/forked — or highlighted — under
  // the wrong agent. One derived value, so no read site can forget the guard.
  const validPick =
    picked && picked.handle.agent === agentType ? picked : null;
  const pickedBlock = validPick ? resumeBlockOf(validPick) : null;
  const sessionOk = canStartFromSession(startMode, validPick !== null, pickedBlock);
  // Resume ignores the location entirely (locked to the recorded cwd — the
  // whole worktree block is hidden); everything else gates on both. Remote
  // ignores the local location too (the agent's cwd is on the box) and only
  // needs a valid endpoint — the Worktree + Start-from sections are hidden.
  // A member takes a role whatever it starts from — fresh, resumed or
  // forked, it is on the team under an address teammates can write to.
  const roleOk = member ? roleAddress !== null : true;
  const valid = forTeam
    ? canCreateAgent(kind, location.branch, baseOk)
    : supportsNew &&
      roleOk &&
      (remote
        ? endpointOk
        : startMode === "resume"
          ? sessionOk
          : canCreateAgent(kind, location.branch, baseOk) && sessionOk);

  return (
    <ModalOverlay>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            onConfirm({
              agentType,
              name,
              location: location.buildLocation(),
              yolo: yolo && supportsYolo,
              ...(remote && endpointOk ? { remoteEndpoint: endpoint.trim() } : {}),
              ...(startMode !== "new" &&
                validPick && {
                  session: { mode: startMode, handle: validPick.handle },
                }),
              ...(target.kind === "new-team" && {
                teamName: teamName.trim() || target.suggestedName,
              }),
              ...(member && roleAddress !== null && { role: roleAddress }),
            });
        }}
      >
        <h2 className="form__title">
          {member ? `New member of “${member.teamName}”` : "New team"}
        </h2>

        {target.kind === "new-team" && (
          <>
            <span className="form__label">Team name</span>
            <input
              {...noAutoCorrect}
              className="form__input"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder={target.suggestedName}
              aria-label="Team name"
              autoFocus
            />
          </>
        )}

        {member && (
          <>
            <span className="form__label">Name</span>
            <input
              {...noAutoCorrect}
              className="form__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional — defaults to the agent number"
              aria-label="Agent name"
            />

            <span className="form__label">Agent</span>
            <div className="form__types">
              {agentOptions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`form__type${a.id === agentType ? " form__type--active" : ""}`}
                  onClick={() => setAgentType(a.id)}
                >
                  <AgentGlyph icon={a.icon} />
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}

        {member && (
          <>
            <span className="form__label">Role</span>
            <Dropdown
              className="form__role-pick"
              options={roleOptions}
              value={roleId}
              onChange={setRoleId}
              ariaLabel="Role"
            />
            {/* The ADDRESS under the field, said in words: the picker names
                what the member is for; the address is what a teammate types,
                and only it tells two implementers apart. Bare, it read as a
                duplicate of the pick ("Lead … lead"); as a sentence it is
                what it is. The refusal takes the same line. */}
            {roleAddress !== null ? (
              <span className="form__role-hint">
                Teammates write to <code className="form__role-address">{roleAddress}</code>
              </span>
            ) : (
              <span className="form__error">
                {pickedRole?.label ?? roleId} is already on this team — pick another role
              </span>
            )}
          </>
        )}

        {member && canRemote && (
          <>
            <span className="form__label">Where</span>
            <div className="form__types">
              {(
                [
                  ["local", "Local"],
                  ["remote", "Remote"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={`form__type${where === val ? " form__type--active" : ""}`}
                  onClick={() => {
                    setWhere(val);
                    // Remote is fresh-session only for now — drop any picked
                    // continuation so the Start-from picker doesn't dangle.
                    if (val === "remote") setStartMode("new");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {remote && (
              <>
                <span className="form__label">Endpoint</span>
                <input
                  {...noAutoCorrect}
                  className="form__input"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={`${remoteSchemes?.[0] ?? "ws"}://host:port — a running agent server`}
                  aria-label="Remote agent server endpoint"
                />
                {!endpointOk && endpoint.length > 0 && (
                  <span className="form__error">
                    Enter a valid {remoteSchemes?.join("/") ?? "ws"}:// endpoint
                  </span>
                )}
              </>
            )}
          </>
        )}

        {!remote && continuations && (
          <>
            <span className="form__label">Start from</span>
            <div className="form__types">
              {startModeOptions.map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`form__type${startMode === mode ? " form__type--active" : ""}`}
                  onClick={() => setStartMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}

        {startMode !== "new" && !remote && (
          <>
            <div className="form__sessions-bar">
              <input
                {...noAutoCorrect}
                className="form__input form__sessions-search"
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder="Search sessions — content, titles"
                aria-label="Search sessions"
              />
              {pagedSessions.total > 0 && (
                <span className="form__sessions-count">
                  {pagedSessions.hasMore
                    ? `${sessions.length} of ${pagedSessions.total}`
                    : `${pagedSessions.total}`}
                </span>
              )}
            </div>
            <ul
              className="form__sessions"
              aria-label="Sessions"
              ref={listRef}
              onScroll={onSessionsScroll}
            >
              {sessions.map((row) => {
                const block =
                  startMode === "resume" ? resumeBlockOf(row) : null;
                const active =
                  validPick?.handle.sessionId === row.handle.sessionId;
                return (
                  <li key={rowKeyOf(row.handle)}>
                    <button
                      type="button"
                      className={`form__session${active ? " form__session--active" : ""}${
                        block !== null ? " form__session--blocked" : ""
                      }${block === "busy-outside" ? " form__session--busy" : ""}`}
                      onClick={() => pickSession(row)}
                    >
                      <span className="form__session-name">
                        {row.handle.title ?? row.handle.sessionId}
                      </span>
                      <span className="form__session-meta">
                        {baseName(row.handle.cwd) || "no directory"} ·{" "}
                        {formatAge(row.mtime, Date.now())}
                        {block !== null && ` · ${blockReason(block)}`}
                      </span>
                    </button>
                  </li>
                );
              })}
              {pagedSessions.loadingMore && (
                <li
                  className="form__session-more"
                  aria-label="Loading more sessions"
                >
                  <span className="form__session-spinner" />
                </li>
              )}
              {sessions.length === 0 && !pagedSessions.loadingMore && (
                <li className="form__session-empty">No sessions match</li>
              )}
            </ul>
            {startMode === "resume" && validPick && (
              pickedBlock === null ? (
                <span className="form__git">
                  ✓ Resumes in {validPick.handle.cwd}
                </span>
              ) : (
                <span className="form__error">
                  Can't resume: {blockReason(pickedBlock)}
                </span>
              )
            )}
          </>
        )}

        {forTeam && repo && (
          <WorktreeLocationField
            location={location}
            repoBranch={repo.branch}
            suggestedPath={suggestedPath}
          />
        )}

        {member && supportsYolo && <YoloField checked={yolo} onChange={setYolo} />}

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            {forTeam
              ? "Create team"
              : startMode === "resume" && !remote
                ? "Resume session"
                : startMode === "fork" && !remote
                  ? "Fork session"
                  : "Add member"}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
