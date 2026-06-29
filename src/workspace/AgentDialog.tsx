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
  /** Pre-filled branch name (the auto default), editable. */
  defaultBranch: string;
  onConfirm(result: AgentDialogResult): void;
  onCancel(): void;
}

/** Folder leaf for a branch — mirrors the backend (slashes/illegal → dashes). */
function worktreeLeaf(branch: string): string {
  return branch
    .trim()
    .replace(/[\s/~^:?*[\]\\@]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Modal shown when adding a single agent to a worktree-mode workspace: lets you
 * name the agent, the branch it creates, and the worktree folder (relative to
 * the workspace's base dir). The folder tracks the branch until edited directly.
 * Batch creation (the spawn form / count picker) skips this and uses auto names.
 */
export function AgentDialog({
  defaultBranch,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState(defaultBranch);
  const [folder, setFolder] = useState(worktreeLeaf(defaultBranch));
  const [folderEdited, setFolderEdited] = useState(false);
  useEscape(onCancel);

  const onBranchChange = (value: string) => {
    setBranch(value);
    // The folder mirrors the branch until the user edits it directly.
    if (!folderEdited) setFolder(worktreeLeaf(value));
  };
  const onFolderChange = (value: string) => {
    setFolder(value);
    setFolderEdited(true);
  };

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
          onChange={(e) => onBranchChange(e.target.value)}
          aria-label="Branch name"
        />
        {branchError && <span className="form__error">{branchError}</span>}

        <span className="form__label">Worktree folder</span>
        <input
          {...noAutoCorrect}
          className="form__input"
          value={folder}
          onChange={(e) => onFolderChange(e.target.value)}
          aria-label="Worktree folder"
        />
        {folderError && <span className="form__error">{folderError}</span>}

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            Create agent
          </button>
        </div>
      </form>
    </div>
  );
}
