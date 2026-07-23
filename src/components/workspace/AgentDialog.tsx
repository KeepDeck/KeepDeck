import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRemoteSchemes,
  agentSupportsYolo,
  canCreateAgent,
  remoteValid,
  canStartFromSession,
  classifyLocation,
  isKnownBaseBranch,
  selectableAgents,
  defaultAgentType as pickDefaultAgentType,
  type AgentDialogResult,
  type AgentLocation,
  type AgentType,
  type LocationKind,
  type Occupancy,
  type PathProbe,
  type ResumeBlock,
  type SessionPickRow,
  type SessionStartMode,
} from "../../domain/agents";
import { baseName } from "../../domain/deck";
import { formatAge } from "../../domain/usage/format";
import { useAgents } from "../../app/useAgents";
import { usePagedSessionSearch, type Page } from "../../app/usePagedSessionSearch";
import { useEscape } from "../../ui/useEscape";
import { useScrollPaging } from "../../ui/useScrollPaging";
import { noAutoCorrect } from "../../ui/inputProps";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { SuggestedInput } from "../../ui/SuggestedInput";
import { Combobox } from "../../ui/Combobox";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { YoloField } from "../../ui/YoloField";
import { AttachIcon, NextIcon } from "../../ui/icons";
import { dirPresent, useDirPresence } from "../history/useDirPresence";

export type { AgentDialogResult } from "../../domain/agents";

interface AgentDialogProps {
  /** Pre-selected agent type. */
  defaultAgentType: AgentType;
  /** The YOLO toggle's starting position (the global preference); shown only
   * while the selected agent's plugin declares YOLO support. */
  defaultYolo: boolean;
  /** Whether the Experimental “Remote agents” setting is on — the "Where:
   *  Remote" option is hidden entirely unless this is true, regardless of an
   *  agent's declared capability. Optional (absent = off) to match the
   *  feature's default-off stance. */
  remoteEnabled?: boolean;
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
  /** How a pane of this deck already holds a candidate path, if one does.
   * Injected (the dialog stays free of deck state). An occupied path pauses
   * Create and offers the user the choice: jump to the next free path, or —
   * for `"worktree"` occupancy, which itself proves the dir is a live
   * worktree — knowingly attach alongside the other agent, instantly. */
  occupancyAt(path: string): Occupancy;
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
   * — running, dormant, or free. Injected (deck state stays outside). */
  sessionClaim(sessionId: string): "running" | "dormant" | null;
  onConfirm(result: AgentDialogResult): void;
  onCancel(): void;
}

/**
 * Modal for the "+ Agent" button. The per-agent worktree/main choice is
 * DERIVED FROM THE PATH ([F2]), not a toggle: an empty "Worktree" field runs
 * the agent in the workspace's main repo; a path creates a new worktree there
 * (or attaches to an existing one). A live hint — modeled on the create
 * wizard's git-detected hint — says what the current path will do. The branch
 * follows the worktree's folder name until the user edits it (the ↺ reset
 * re-attaches it to the path). Agent type and location are per-agent, not
 * tied to the workspace; the type list is the detected install catalog ([F1]).
 */
export function AgentDialog({
  defaultAgentType,
  defaultYolo,
  remoteEnabled = false,
  repo,
  suggestedPath,
  suggestedBranch,
  probePath,
  listBranches,
  branchForPath,
  occupancyAt,
  nextFreeLocation,
  pickFolder,
  searchSessions,
  sessionClaim,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [agentType, setAgentType] = useState<AgentType>(defaultAgentType);
  const [name, setName] = useState("");
  // The toggle's state survives switching through a non-supporting agent —
  // only the SUBMITTED value is gated (see `supportsYolo` below).
  const [yolo, setYolo] = useState(defaultYolo);
  const [path, setPath] = useState(suggestedPath);
  const [branch, setBranch] = useState(suggestedBranch);
  // The base the new worktree branch forks from. Prefilled with the repo's
  // current branch, so the field always NAMES its base instead of implying
  // one through a placeholder. Cleared — or opened on a detached HEAD — it
  // falls back to the repo HEAD, the default since before the picker existed.
  const [baseBranch, setBaseBranch] = useState(repo?.branch ?? "");
  // Null until (unless) the listing lands: validation is off without a list,
  // so a dead IPC degrades the picker to free text instead of blocking.
  const [branches, setBranches] = useState<string[] | null>(null);
  // The live branch suggestion, following the path's folder name. Equality is
  // the whole edit-tracking: while `branch === derivedBranch` the branch is
  // untouched and keeps following; an edit detaches it; the ↺ reset restores
  // equality and re-attaches — exactly SuggestedInput's own state machine.
  const [derivedBranch, setDerivedBranch] = useState(suggestedBranch);
  const derivedRef = useRef(suggestedBranch);
  const [probe, setProbe] = useState<PathProbe | null>(null);
  // The user's explicit "Attach anyway" on an occupied path; any path edit
  // voids it — consent covers the path it was given for, not the next one.
  const [attachAnyway, setAttachAnyway] = useState(false);
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
  const [sessionQuery, setSessionQuery] = useState("");
  const [picked, setPicked] = useState<SessionPickRow | null>(null);
  // What the Name field was last prefilled with (a picked session's title):
  // while name === prefill the field is untouched and follows the picks,
  // an edit detaches it — SuggestedInput's state machine, hand-rolled.
  const prefillRef = useRef("");
  const { agents } = useAgents();
  const agentOptions = selectableAgents(agents);
  useEscape(onCancel);

  // The picker's options, paged through the SAME engine as the global browser
  // ([[usePagedSessionSearch]]) — the fetcher is scoped to the selected agent
  // and re-scopes when the user switches. Virtualization/paging were missing
  // here before: the list was capped at one page.
  const pagedSessions = usePagedSessionSearch<SessionPickRow>(
    useCallback(
      (query, limit, offset) =>
        searchSessions(agentType, query, limit, offset),
      [searchSessions, agentType],
    ),
  );
  const sessions = pagedSessions.rows;
  const listRef = useRef<HTMLUListElement | null>(null);
  const onSessionsScroll = useScrollPaging(
    listRef,
    pagedSessions,
    sessions.length,
  );

  // Re-query as the user types, switches agent, or opens resume/fork. Skipped
  // for "new" (no picker shown); the shared engine debounces and pages.
  const { search: searchSessionsPage } = pagedSessions;
  useEffect(() => {
    if (startMode === "new") return;
    searchSessionsPage(sessionQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMode, agentType, sessionQuery]);

  // Prefill the Name from a session title while the field is UNTOUCHED (name
  // still equals the last prefill); a hand-edited name stays the user's. The
  // previous prefill is captured BEFORE reassigning the ref — setName's updater
  // runs later, by which point prefillRef.current would already be `next`.
  const applyPrefill = (next: string) => {
    const previous = prefillRef.current;
    setName((current) => (current === previous ? next : current));
    prefillRef.current = next;
  };

  // A pick belongs to ONE agent's store — switching agents voids it (and the
  // typed filter; the fresh listing shouldn't open pre-narrowed). An
  // auto-filled (untouched) name came from that pick's title, so drop it too.
  useEffect(() => {
    setPicked(null);
    setSessionQuery("");
    applyPrefill("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType]);

  // Resume needs the session's directory alive — same gate as the browser.
  const presence = useDirPresence(
    startMode === "resume" ? sessions.map((s) => s.handle.cwd) : [],
  );
  const resumeBlockOf = (row: SessionPickRow): ResumeBlock => {
    if (row.handle.cwd === "") return "no-cwd";
    if (sessionClaim(row.handle.sessionId) !== null) return "claimed";
    if (!dirPresent(presence, row.handle.cwd)) return "dir-gone";
    return null;
  };
  const blockReason = (block: ResumeBlock): string | null => {
    switch (block) {
      case "no-cwd":
        return "no recorded directory — fork instead";
      case "claimed":
        return "already in a pane";
      case "dir-gone":
        return "directory is gone — fork instead";
      case null:
        return null;
    }
  };

  const pickSession = (row: SessionPickRow) => {
    // Ignore a click on a row from a DIFFERENT agent than the selected one —
    // reachable only on a row still rendered from the previous agent during the
    // search debounce window. `validPick` already blocks it downstream; this
    // also stops the Name from prefilling off a pick that can't be used.
    if (row.handle.agent !== agentType) return;
    setPicked(row);
    applyPrefill(row.handle.title ?? "");
  };

  // Snap the pre-selected type onto the installed set once detection resolves
  // (the default may have been a not-installed fallback) ([F1]).
  useEffect(() => {
    if (agentOptions.length && !agentOptions.some((a) => a.id === agentType)) {
      setAgentType(pickDefaultAgentType(agents));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  // Live-probe the entered path (debounced) to drive the hint. A null probe
  // while a non-empty path is pending reads as "checking".
  useEffect(() => {
    if (!repo || !path.trim()) {
      setProbe(null);
      return;
    }
    setProbe(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      probePath(path)
        .then((p) => {
          if (!cancelled) setProbe(p);
        })
        .catch(() => {
          if (!cancelled)
            setProbe({ exists: false, isWorktree: false, empty: false, branch: null });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, repo]);

  useEffect(() => setAttachAnyway(false), [path]);

  // Load the base-branch options once per dialog: the workspace repo is fixed
  // for its lifetime. A failure just leaves `branches` null (see above).
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    listBranches(repo.cwd)
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // Follow the path with the branch (debounced like the probe): an untouched
  // branch — one still equal to the suggestion it came from — moves to the new
  // path's implied branch; an edited one stays the user's.
  useEffect(() => {
    if (!repo || !path.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      branchForPath(path)
        .then((b) => {
          if (cancelled || b === null) return;
          const previous = derivedRef.current;
          setBranch((prev) => (prev === previous ? b : prev));
          derivedRef.current = b;
          setDerivedBranch(b);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, repo]);

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
  const occupancy = repo && path.trim() ? occupancyAt(path) : null;
  const kind = repo
    ? classifyLocation(path, probe, occupancy, attachAnyway)
    : "main";
  // What the LAYOUT renders while a probe is in flight: "checking" is the
  // only transient kind, and every keystroke in the path field passes through
  // it — unmounting the Branch/Base fields on each one made the whole dialog
  // jump. The last settled kind holds the layout still; `kind` itself keeps
  // gating Create, so nothing can be submitted against a stale read. Seeded
  // optimistically: a prefilled path was already probed free by the opener,
  // so the dialog opens at its full height instead of growing a beat later.
  const settledKindRef = useRef<LocationKind>(
    suggestedPath.trim() ? "new" : "main",
  );
  if (kind !== "checking") settledKindRef.current = kind;
  const layoutKind = settledKindRef.current;
  const baseOk = isKnownBaseBranch(baseBranch, branches);
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
  const valid = remote
    ? endpointOk
    : startMode === "resume"
      ? sessionOk
      : canCreateAgent(kind, branch, baseOk) && sessionOk;

  // "Use next available": swap the occupied path (and its branch) for the
  // next free suggestion. A null result (no base, IPC down) leaves the field
  // as is — the blocking hint still explains the state.
  const useNextFree = async () => {
    const free = await nextFreeLocation(path);
    if (free) {
      setPath(free.path);
      setBranch(free.branch);
    }
  };

  const buildLocation = (): AgentLocation => {
    if (kind === "new")
      return {
        kind: "new",
        path: path.trim(),
        branch: branch.trim(),
        baseBranch: baseBranch.trim() || undefined,
      };
    if (kind === "existing")
      return { kind: "existing", path: path.trim(), branch: (probe?.branch ?? "").trim() };
    return { kind: "main" };
  };

  // "Choose…" picks the worktree folder itself — the agent's project lives
  // directly in it, not in a subfolder ([F2]). git accepts a non-existent or
  // existing-empty dir; the field stays editable for typing a fresh path.
  const choosePath = async () => {
    const dir = await pickFolder("Choose the worktree folder");
    if (dir !== null) setPath(dir);
  };

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
              location: buildLocation(),
              yolo: yolo && supportsYolo,
              ...(remote && endpointOk ? { remoteEndpoint: endpoint.trim() } : {}),
              ...(startMode !== "new" &&
                validPick && {
                  session: { mode: startMode, handle: validPick.handle },
                }),
            });
        }}
      >
        <h2 className="form__title">New agent</h2>

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

        {canRemote && (
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

        {!remote && (
          <>
            <span className="form__label">Start from</span>
            <div className="form__types">
              {(
                [
                  ["new", "New session"],
                  ["resume", "Resume"],
                  ["fork", "Fork"],
                ] as const
              ).map(([mode, label]) => (
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
                  <li key={`${row.handle.agent}:${row.handle.sessionId}`}>
                    <button
                      type="button"
                      className={`form__session${active ? " form__session--active" : ""}${
                        block !== null ? " form__session--blocked" : ""
                      }`}
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

        {repo && startMode !== "resume" && !remote && (
          <>
            <span className="form__label">Worktree</span>
            <div className="form__path">
              <SuggestedInput
                value={path}
                suggestion={suggestedPath}
                onChange={setPath}
                className="form__path-field"
                placeholder="Empty = main repo · a path = worktree"
                ariaLabel="Worktree path"
                clearTitle="Clear — run in the main repo"
                resetTitle="Reset to the suggested path"
              />
              <button type="button" className="form__dir-btn" onClick={choosePath}>
                Choose…
              </button>
            </div>
            <LocationHint
              kind={kind}
              repoBranch={repo.branch}
              probe={probe}
              canAttach={occupancy === "worktree"}
              onUseNext={useNextFree}
              onAttachAnyway={() => setAttachAnyway(true)}
            />

            {layoutKind === "new" && (
              <>
                <span className="form__label">Branch</span>
                <SuggestedInput
                  value={branch}
                  suggestion={derivedBranch}
                  onChange={setBranch}
                  className="form__field--gap"
                  ariaLabel="Branch name"
                  resetTitle="Reset to the suggested branch"
                />
                {!branch.trim() && (
                  <span className="form__error">Branch is required</span>
                )}

                <span className="form__label">Base branch</span>
                <Combobox
                  options={branches ?? []}
                  value={baseBranch}
                  onChange={setBaseBranch}
                  className="form__field--gap"
                  ariaLabel="Base branch"
                />
                {!baseOk && (
                  <span className="form__error">No such local branch</span>
                )}
              </>
            )}
          </>
        )}

        {supportsYolo && <YoloField checked={yolo} onChange={setYolo} />}

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            {remote
              ? "Create agent"
              : startMode === "resume"
                ? "Resume session"
                : startMode === "fork"
                  ? "Fork session"
                  : "Create agent"}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}

/** The live hint under the worktree field: what the current path will do.
 * The unusable states are a choice, not a dead end — inline icon actions let
 * the user jump to the next free path (occupied AND blocked paths both offer
 * it) or, for an occupied path whose dir is a live worktree (`canAttach`),
 * attach alongside the other agent anyway. */
function LocationHint({
  kind,
  repoBranch,
  probe,
  canAttach,
  onUseNext,
  onAttachAnyway,
}: {
  kind: ReturnType<typeof classifyLocation>;
  repoBranch: string | null;
  probe: PathProbe | null;
  canAttach: boolean;
  onUseNext(): void;
  onAttachAnyway(): void;
}) {
  switch (kind) {
    case "main":
      return (
        <span className="form__git">
          ✓ Runs in the main repo{repoBranch ? ` · ${repoBranch}` : ""}
        </span>
      );
    case "checking":
      return <span className="form__git">Checking path…</span>;
    case "new":
      return <span className="form__git">✓ New worktree on a new branch</span>;
    case "existing":
      return (
        <span className="form__git">
          ✓ Attach to existing worktree
          {probe?.branch ? ` · ${probe.branch}` : ""}
        </span>
      );
    case "occupied":
      return (
        <>
          <span className="form__error">Already in use by another agent</span>
          <div className="form__choices">
            <button
              type="button"
              className="form__choice"
              onClick={onUseNext}
              title="Use next available"
              aria-label="Use next available"
            >
              <NextIcon />
            </button>
            {canAttach && (
              <button
                type="button"
                className="form__choice"
                onClick={onAttachAnyway}
                title="Attach anyway"
                aria-label="Attach anyway"
              >
                <AttachIcon />
              </button>
            )}
          </div>
        </>
      );
    case "blocked":
      return (
        <>
          <span className="form__error">
            Folder has files and isn't a worktree — pick a new or empty folder
          </span>
          <div className="form__choices">
            <button
              type="button"
              className="form__choice"
              onClick={onUseNext}
              title="Use next available"
              aria-label="Use next available"
            >
              <NextIcon />
            </button>
          </div>
        </>
      );
  }
}
