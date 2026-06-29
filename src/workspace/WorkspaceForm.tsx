import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AGENT_TYPES, type AgentType } from "../agents";
import { inspectRepo } from "../worktree";
import { TERMINAL_COUNTS, TerminalCountTiles } from "./TerminalCountTiles";

export interface SpawnConfig {
  /** Workspace name; blank falls back to a default in the caller. */
  name: string;
  cwd: string;
  agentType: AgentType;
  count: number;
  /** Base folder for per-agent git worktrees; `null` = agents run in `cwd`. */
  worktreeBaseDir: string | null;
}

interface WorkspaceFormProps {
  onCreate(config: SpawnConfig): void;
  /** Provided only when there's a workspace to return to (omitted on first run). */
  onCancel?(): void;
}

/**
 * Centered spawn-settings form for a new workspace: working directory
 * (required), agent type, and how many agents. Reused as the empty state when
 * no workspaces exist.
 */
export function WorkspaceForm({ onCreate, onCancel }: WorkspaceFormProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [count, setCount] = useState(1);
  const [worktreeDir, setWorktreeDir] = useState<string | null>(null);

  const chooseDirectory = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose working directory",
    });
    if (typeof selected === "string") setCwd(selected);
  };

  const chooseWorktreeDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a base folder for agent worktrees",
    });
    if (typeof selected === "string") setWorktreeDir(selected);
  };

  const submit = async () => {
    if (!cwd) return;
    // No worktree dir chosen, but the working dir is a git repo → nudge, since
    // running every agent in one repo working tree is what worktrees avoid.
    if (!worktreeDir) {
      const info = await inspectRepo(cwd);
      if (info.isRepo) {
        const proceed = window.confirm(
          "This folder is a git repository.\n\n" +
            "Run all agents directly in it, without an isolated git worktree " +
            "per agent? Choose a worktree directory to isolate them, or confirm " +
            "to continue without.",
        );
        if (!proceed) return;
      }
    }
    onCreate({ name, cwd, agentType, count, worktreeBaseDir: worktreeDir });
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

      <span className="form__label">Worktree directory (optional)</span>
      <div className="form__dir">
        <span
          className={`form__dir-path${worktreeDir ? "" : " form__dir-path--empty"}`}
          title={worktreeDir ?? undefined}
        >
          {worktreeDir ?? "Agents run in the working directory"}
        </span>
        {worktreeDir && (
          <button
            type="button"
            className="form__dir-btn"
            onClick={() => setWorktreeDir(null)}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className="form__dir-btn"
          onClick={chooseWorktreeDir}
        >
          Choose…
        </button>
      </div>

      <span className="form__label">Agent</span>
      <div className="form__types">
        {AGENT_TYPES.map((a) => (
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

      <span className="form__label">Agents</span>
      <TerminalCountTiles
        counts={TERMINAL_COUNTS}
        value={count}
        onPick={setCount}
      />

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
