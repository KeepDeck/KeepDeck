import { useState } from "react";
import { useEscape } from "../ui/useEscape";
import { noAutoCorrect } from "../ui/inputProps";

export interface AgentDialogResult {
  /** Optional custom display name; blank falls back to the derived title. */
  name: string;
  /** Branch to create for the agent's worktree. */
  branch: string;
  /** Worktree folder name (relative to the workspace's base dir). */
  folder: string;
}

interface AgentDialogProps {
  /** Pre-filled branch name (backend default), editable. */
  defaultBranch: string;
  /** Pre-filled worktree folder (backend default), editable. */
  defaultFolder: string;
  onConfirm(result: AgentDialogResult): void;
  onCancel(): void;
}

/**
 * Modal shown when adding a single agent to a worktree-mode workspace: edit the
 * agent name, the branch it creates, and the worktree folder (relative to the
 * workspace's base dir). Branch and folder are prefilled from the backend (the
 * single source of naming) and edited independently. Batch creation (the spawn
 * form / count picker) skips this and uses the same backend defaults.
 */
export function AgentDialog({
  defaultBranch,
  defaultFolder,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState(defaultBranch);
  const [folder, setFolder] = useState(defaultFolder);
  useEscape(onCancel);

  const branchError = branch.trim() ? null : "Branch is required";
  const folderError = folder.trim() ? null : "Folder is required";
  const valid = !branchError && !folderError;

  return (
    <div className="modal-overlay">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onConfirm({ name, branch, folder });
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

        <span className="form__label">Branch</span>
        <input
          {...noAutoCorrect}
          className="form__input"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          aria-label="Branch name"
        />
        {branchError && <span className="form__error">{branchError}</span>}

        <span className="form__label">Worktree folder</span>
        <input
          {...noAutoCorrect}
          className="form__input"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          aria-label="Worktree folder"
        />
        {folderError && <span className="form__error">{folderError}</span>}

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="form__create"
            disabled={!valid}
          >
            Create agent
          </button>
        </div>
      </form>
    </div>
  );
}
