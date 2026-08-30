import { useEffect, useState } from "react";
import type { SpawnConfig } from "../../domain/deck";
import { useEscape } from "../../ui/useEscape";
import { noAutoCorrect } from "../../ui/inputProps";
import { SuggestedInput } from "../../ui/SuggestedInput";

export type { SpawnConfig } from "../../domain/deck";

interface WorkspaceFormProps {
  /** Registers the workspace immediately (optimistic provisioning) — the
   * caller closes the form on the same tick, so there is no busy state. */
  onCreate(config: SpawnConfig): void;
  /** Provided only when there's a workspace to return to (omitted on first run). */
  onCancel?(): void;
  /** Native folder picker; null when cancelled. Injected so the form stays
   * free of IPC. */
  pickFolder(title: string): Promise<string | null>;
  /** Probe a chosen working directory for the git hint (injected likewise). */
  inspectDir(path: string): Promise<{ isRepo: boolean; branch: string | null }>;
}

/**
 * Centered spawn-settings form for a new workspace: its name, its working
 * directory (required), and where the worktrees of the agents added to it will
 * go. Reused as the empty state when no workspaces exist.
 *
 * A workspace is born EMPTY. It used to be created with a batch of agents, so
 * the form also had to ask which agent type to run, whether to run it in YOLO
 * mode, and — because those agents were about to start — whether the user
 * really meant to run them all in one working tree. Nothing spawns at create
 * time now, so all three questions moved to the "+ Agent" dialog that actually
 * starts an agent and shows it the directory it will run in. What is left is
 * only what the workspace itself is made of — none of it per-agent.
 */
export function WorkspaceForm({
  onCreate,
  onCancel,
  pickFolder,
  inspectDir,
}: WorkspaceFormProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  // Empty string = no worktree isolation; maps to null in SpawnConfig.
  const [worktreeDir, setWorktreeDir] = useState("");
  const [git, setGit] = useState<{ isRepo: boolean; branch: string | null } | null>(
    null,
  );

  // Probe the chosen working directory, for the "git detected" hint.
  useEffect(() => {
    if (!cwd) {
      setGit(null);
      return;
    }
    let cancelled = false;
    inspectDir(cwd)
      .then((info) => {
        if (!cancelled) setGit({ isRepo: info.isRepo, branch: info.branch });
      })
      .catch(() => {
        if (!cancelled) setGit(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // Esc closes the form when there's a workspace to return to.
  useEscape(() => onCancel?.(), Boolean(onCancel));

  const chooseDirectory = async () => {
    const selected = await pickFolder("Choose working directory");
    if (selected !== null) setCwd(selected);
  };

  const chooseWorktreeDir = async () => {
    const selected = await pickFolder(
      "Choose a base folder for agent worktrees",
    );
    if (selected !== null) setWorktreeDir(selected);
  };

  const submit = () => {
    if (!cwd) return;
    onCreate({
      name,
      cwd,
      worktreeBaseDir: worktreeDir.trim() || null,
    });
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="form__title">New workspace</h2>

      <span className="form__label">Name</span>
      <input
        {...noAutoCorrect}
        className="form__input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Optional — defaults to workspace-N"
        aria-label="Workspace name"
      />

      <span className="form__label">Working directory</span>
      <div className="form__dir">
        <span
          className={`form__dir-path${cwd ? "" : " form__dir-path--empty"}`}
          title={cwd ?? undefined}
        >
          {cwd ?? "No folder chosen"}
        </span>
        <button
          type="button"
          className="form__dir-btn"
          onClick={chooseDirectory}
        >
          Choose…
        </button>
      </div>
      {git?.isRepo && (
        <span className="form__git">
          ✓ Git repository detected{git.branch ? ` · ${git.branch}` : ""}
        </span>
      )}

      <span className="form__label">Worktree directory (optional)</span>
      <div className="form__path">
        <SuggestedInput
          value={worktreeDir}
          suggestion=""
          onChange={setWorktreeDir}
          className="form__path-field"
          placeholder="Agents run in the working directory"
          ariaLabel="Worktree directory"
          clearTitle="Clear — agents run in the working directory"
        />
        <button
          type="button"
          className="form__dir-btn"
          onClick={chooseWorktreeDir}
        >
          Choose…
        </button>
      </div>

      <div className="form__actions">
        {onCancel && (
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="form__create"
          disabled={!cwd}
          title={cwd ? "Create workspace" : "Choose a working directory first"}
        >
          Create workspace
        </button>
      </div>
    </form>
  );
}
