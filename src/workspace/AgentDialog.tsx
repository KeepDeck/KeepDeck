import { useState } from "react";

export interface AgentDialogResult {
  /** Optional custom display name; blank falls back to the derived title. */
  name: string;
  /** Branch to create for the agent's worktree. */
  branch: string;
}

interface AgentDialogProps {
  /** Pre-filled branch name (the auto default), editable. */
  defaultBranch: string;
  /** Base folder for worktrees; the path preview is derived from it + branch. */
  baseDir: string;
  onConfirm(result: AgentDialogResult): void;
  onCancel(): void;
}

/** Folder leaf for a branch — mirrors the backend (slashes/illegal → dashes). */
function worktreeLeaf(branch: string): string {
  return (
    branch
      .trim()
      .replace(/[\s/~^:?*[\]\\@]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "agent"
  );
}

/**
 * Modal shown when adding a single agent to a worktree-mode workspace: lets you
 * name the agent and the branch it creates, and previews the resolved worktree
 * path. Batch creation (the spawn form / count picker) skips this and uses auto
 * branch names.
 */
export function AgentDialog({
  defaultBranch,
  baseDir,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState(defaultBranch);
  const path = `${baseDir}/${worktreeLeaf(branch)}`;

  return (
    <div className="deck__overlay">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm({ name, branch });
        }}
      >
        <h2 className="form__title">New agent</h2>

        <span className="form__label">Name</span>
        <input
          className="form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optional — defaults to the agent number"
          aria-label="Agent name"
        />

        <span className="form__label">Branch</span>
        <input
          className="form__input"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          aria-label="Branch name"
        />

        <span className="form__label">Worktree path</span>
        <span className="form__dir-path" title={path}>
          {path}
        </span>

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="form__create"
            disabled={!branch.trim()}
          >
            Create agent
          </button>
        </div>
      </form>
    </div>
  );
}
