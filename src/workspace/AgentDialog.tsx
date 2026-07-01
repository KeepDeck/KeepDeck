import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useAgents,
  selectableAgents,
  defaultAgentType as pickDefaultAgentType,
  type AgentType,
} from "../agents";
import { probeWorktree } from "../worktree";
import { useEscape } from "../ui/useEscape";
import { noAutoCorrect } from "../ui/inputProps";
import { ModalOverlay } from "../ui/ModalOverlay";
import {
  canCreateAgent,
  classifyLocation,
  type AgentDialogResult,
  type AgentLocation,
  type PathProbe,
} from "./agentLocation";

export type { AgentDialogResult } from "./agentLocation";

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
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [agentType, setAgentType] = useState<AgentType>(defaultAgentType);
  const [name, setName] = useState("");
  const [path, setPath] = useState(suggestedPath);
  const [branch, setBranch] = useState(suggestedBranch);
  const [probe, setProbe] = useState<PathProbe | null>(null);
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
      probeWorktree(path)
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
  }, [path, repo]);

  const kind = repo ? classifyLocation(path, probe) : "main";
  const valid = canCreateAgent(kind, branch);

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
    const dir = await open({
      directory: true,
      multiple: false,
      title: "Choose the worktree folder",
    });
    if (typeof dir === "string") setPath(dir);
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
              <div className="form__path-field">
                <input
                  {...noAutoCorrect}
                  className="form__input form__path-input"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="Empty = main repo · a path = worktree"
                  aria-label="Worktree path"
                />
                {path && (
                  <button
                    type="button"
                    className="form__path-clear"
                    onClick={() => setPath("")}
                    title="Clear — run in the main repo"
                    aria-label="Clear worktree path"
                  >
                    ×
                  </button>
                )}
              </div>
              <button type="button" className="form__dir-btn" onClick={choosePath}>
                Choose…
              </button>
            </div>
            <LocationHint kind={kind} repoBranch={repo.branch} probe={probe} />

            {kind === "new" && (
              <>
                <span className="form__label">Branch</span>
                <input
                  {...noAutoCorrect}
                  className="form__input"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  aria-label="Branch name"
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

/** The live hint under the worktree field: what the current path will do. */
function LocationHint({
  kind,
  repoBranch,
  probe,
}: {
  kind: ReturnType<typeof classifyLocation>;
  repoBranch: string | null;
  probe: PathProbe | null;
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
    case "blocked":
      return (
        <span className="form__error">Folder exists and isn't a git worktree</span>
      );
  }
}
