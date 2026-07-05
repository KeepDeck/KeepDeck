import { useEffect, useState } from "react";
import {
  canCreateAgent,
  classifyLocation,
  selectableAgents,
  defaultAgentType as pickDefaultAgentType,
  type AgentDialogResult,
  type AgentLocation,
  type AgentType,
  type Occupancy,
  type PathProbe,
} from "../../domain/agents";
import { useAgents } from "../../app/useAgents";
import { useEscape } from "../../ui/useEscape";
import { noAutoCorrect } from "../../ui/inputProps";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { SuggestedInput } from "../../ui/SuggestedInput";
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
  /** Prefilled branch for a new worktree. */
  suggestedBranch: string;
  /** Probe a candidate worktree path for the live hint (injected — the dialog
   * itself stays free of IPC). */
  probePath(path: string): Promise<PathProbe>;
  /** How a pane of this deck already holds a candidate path, if one does.
   * Injected (the dialog stays free of deck state). An occupied path pauses
   * Create and offers the user the choice: jump to the next free path, or —
   * for `"worktree"` occupancy, which itself proves the dir is a live
   * worktree — knowingly attach alongside the other agent, instantly. */
  occupancyAt(path: string): Occupancy;
  /** The next suggested location not held by an open pane — the "Use next
   * available" action for an occupied path; null when none can be offered. */
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
 * wizard's git-detected hint — says what the current path will do. Agent type
 * and location are per-agent, not tied to the workspace; the type list is the
 * detected install catalog ([F1]).
 */
export function AgentDialog({
  defaultAgentType,
  repo,
  suggestedPath,
  suggestedBranch,
  probePath,
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

  const occupancy = repo && path.trim() ? occupancyAt(path) : null;
  const kind = repo
    ? classifyLocation(path, probe, occupancy, attachAnyway)
    : "main";
  const valid = canCreateAgent(kind, branch);

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
    if (kind === "new") return { kind: "new", path: path.trim(), branch: branch.trim() };
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

            {kind === "new" && (
              <>
                <span className="form__label">Branch</span>
                <SuggestedInput
                  value={branch}
                  suggestion={suggestedBranch}
                  onChange={setBranch}
                  className="form__field--gap"
                  ariaLabel="Branch name"
                  resetTitle="Reset to the suggested branch"
                />
                {!branch.trim() && (
                  <span className="form__error">Branch is required</span>
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
 * The occupied state is a choice, not a dead end — inline icon actions let
 * the user jump to the next free path or (when the occupant's dir is a live
 * worktree, `canAttach`) attach alongside it anyway. */
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
        <span className="form__error">
          Folder has files and isn't a worktree — pick a new or empty folder
        </span>
      );
  }
}
