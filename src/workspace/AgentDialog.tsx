import { useEffect, useState } from "react";
import {
  useAgents,
  selectableAgents,
  defaultAgentType as pickDefaultAgentType,
  type AgentType,
} from "../agents";
import { useEscape } from "../ui/useEscape";
import { noAutoCorrect } from "../ui/inputProps";
import { ModalOverlay } from "../ui/ModalOverlay";

export interface AgentDialogResult {
  /** The agent type to spawn. */
  agentType: AgentType;
  /** Optional custom display name; blank falls back to the derived title. */
  name: string;
  /** Branch to create for the agent's worktree (worktree mode only). */
  branch?: string;
  /** Worktree folder name relative to the base dir (worktree mode only). */
  folder?: string;
}

interface AgentDialogProps {
  /** Pre-selected agent type. */
  defaultAgentType: AgentType;
  /** Present only in worktree mode — show + require branch/folder, prefilled. */
  worktree?: { defaultBranch: string; defaultFolder: string };
  onConfirm(result: AgentDialogResult): void;
  onCancel(): void;
}

/**
 * Modal shown whenever a single agent is added (the "+ Agent" button). Always
 * lets you pick the agent type and an optional name; in worktree-mode workspaces
 * it also shows the branch + worktree folder (prefilled from the backend), which
 * are required. Agent type is per-pane, not tied to the workspace.
 */
export function AgentDialog({
  defaultAgentType,
  worktree,
  onConfirm,
  onCancel,
}: AgentDialogProps) {
  const [agentType, setAgentType] = useState<AgentType>(defaultAgentType);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState(worktree?.defaultBranch ?? "");
  const [folder, setFolder] = useState(worktree?.defaultFolder ?? "");
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

  const branchError = worktree && !branch.trim() ? "Branch is required" : null;
  const folderError = worktree && !folder.trim() ? "Folder is required" : null;
  const valid = !branchError && !folderError;

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
              branch: worktree ? branch : undefined,
              folder: worktree ? folder : undefined,
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

        {worktree && (
          <>
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
