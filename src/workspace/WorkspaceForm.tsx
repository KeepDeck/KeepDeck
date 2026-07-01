import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useAgents,
  selectableAgents,
  defaultAgentType,
  type AgentType,
} from "../agents";
import { inspectRepo } from "../worktree";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useEscape } from "../ui/useEscape";
import { noAutoCorrect } from "../ui/inputProps";
import { WORKSPACE_COUNTS, TerminalCountTiles } from "./TerminalCountTiles";

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
  /** Provisioning in flight — disables Create to block a reentrant submit. */
  busy?: boolean;
}

/**
 * Centered spawn-settings form for a new workspace: working directory
 * (required), agent type, and how many agents. Reused as the empty state when
 * no workspaces exist.
 */
export function WorkspaceForm({ onCreate, onCancel, busy }: WorkspaceFormProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const { agents } = useAgents();
  const agentOptions = selectableAgents(agents);
  const [count, setCount] = useState(1);
  const [worktreeDir, setWorktreeDir] = useState<string | null>(null);
  const [nudge, setNudge] = useState(false);
  const [git, setGit] = useState<{ isRepo: boolean; branch: string | null } | null>(
    null,
  );

  // Probe the chosen working directory: show a "git detected" hint and decide
  // whether to nudge toward worktree isolation on submit.
  useEffect(() => {
    if (!cwd) {
      setGit(null);
      return;
    }
    let cancelled = false;
    inspectRepo(cwd)
      .then((info) => {
        if (!cancelled) setGit({ isRepo: info.isRepo, branch: info.branch });
      })
      .catch(() => {
        if (!cancelled) setGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Once detection resolves, snap off an uninstalled default (e.g. "claude" when
  // only OpenCode is installed) to the first selectable agent ([F1]).
  useEffect(() => {
    if (agentOptions.length && !agentOptions.some((a) => a.id === agentType)) {
      setAgentType(defaultAgentType(agents));
    }
    // Re-check only when the catalog changes, not on every manual pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  // Esc closes the form when there's a workspace to return to — but not while
  // the nudge is open (its own Esc handles that, so the form stays put).
  useEscape(() => {
    if (onCancel && !nudge) onCancel();
  });

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

  const create = () => {
    if (cwd) onCreate({ name, cwd, agentType, count, worktreeBaseDir: worktreeDir });
  };

  const submit = () => {
    if (!cwd) return;
    // No worktree dir chosen but the working dir is a git repo → in-app nudge
    // (no system dialogs) before running every agent in one repo working tree.
    // Skipped for an empty workspace ([F15]): no agents run, nothing to isolate.
    if (count > 0 && !worktreeDir && git?.isRepo) {
      setNudge(true);
      return;
    }
    create();
  };

  return (
    <>
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
      {/* Agent type is per-pane and only used when agents spawn, so it's
          irrelevant for an empty workspace ([F15]) — dim + disable it at 0. */}
      <div
        className="form__types"
        style={count === 0 ? { opacity: 0.4, pointerEvents: "none" } : undefined}
        aria-disabled={count === 0}
      >
        {agentOptions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`form__type${a.id === agentType ? " form__type--active" : ""}`}
            onClick={() => setAgentType(a.id)}
            tabIndex={count === 0 ? -1 : undefined}
          >
            {a.label}
          </button>
        ))}
      </div>

      <span className="form__label">Agents</span>
      <TerminalCountTiles
        counts={WORKSPACE_COUNTS}
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
          disabled={!cwd || busy}
          title={cwd ? "Create workspace" : "Choose a working directory first"}
        >
          {busy ? "Creating…" : "Create workspace"}
        </button>
      </div>
    </form>
      {nudge && (
        <ConfirmDialog
          title="No worktree isolation"
          message={
            "This folder is a git repository. Run all agents directly in it, " +
            "without an isolated git worktree per agent?\n\n" +
            "Pick a worktree directory to isolate them, or continue without."
          }
          confirmLabel="Continue without"
          cancelLabel="Cancel"
          onConfirm={() => {
            setNudge(false);
            create();
          }}
          onCancel={() => setNudge(false)}
        />
      )}
    </>
  );
}
