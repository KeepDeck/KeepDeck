import { useEffect, useRef, useState } from "react";
import {
  canCreateAgent,
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
} from "../../domain/agents";
import { useAgents } from "../../app/useAgents";
import { useEscape } from "../../ui/useEscape";
import { noAutoCorrect } from "../../ui/inputProps";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { SuggestedInput } from "../../ui/SuggestedInput";
import { Combobox } from "../../ui/Combobox";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { AttachIcon, NextIcon } from "../../ui/icons";

export type { AgentDialogResult } from "../../domain/agents";

interface AgentDialogProps {
  /** Pre-selected agent type. */
  defaultAgentType: AgentType;
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
  repo,
  suggestedPath,
  suggestedBranch,
  probePath,
  listBranches,
  branchForPath,
  occupancyAt,
  nextFreeLocation,
  pickFolder,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [agentType, setAgentType] = useState<AgentType>(defaultAgentType);
  const [name, setName] = useState("");
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
  const { agents } = useAgents();
  const agentOptions = selectableAgents(agents);
  useEscape(onCancel);

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
  const valid = canCreateAgent(kind, branch, baseOk);

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
          if (valid) onConfirm({ agentType, name, location: buildLocation() });
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

        {repo && (
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

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            Create agent
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
