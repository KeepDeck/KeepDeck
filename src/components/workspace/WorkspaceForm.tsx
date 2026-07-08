import { useEffect, useRef, useState } from "react";
import {
  selectableAgents,
  defaultAgentType,
  type AgentType,
} from "../../domain/agents";
import { useAgents } from "../../app/useAgents";
import { useSettings } from "../../app/useSettings";
import type { SpawnConfig } from "../../domain/deck";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useEscape } from "../../ui/useEscape";
import { noAutoCorrect } from "../../ui/inputProps";
import { SuggestedInput } from "../../ui/SuggestedInput";
import { WORKSPACE_COUNTS, TerminalCountTiles } from "./TerminalCountTiles";

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
 * Centered spawn-settings form for a new workspace: working directory
 * (required), agent type, and how many agents. Reused as the empty state when
 * no workspaces exist.
 */
export function WorkspaceForm({
  onCreate,
  onCancel,
  pickFolder,
  inspectDir,
}: WorkspaceFormProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const settings = useSettings();
  // Global default agent preference ([F6]), straight from the settings store.
  // Loaded before the form can mount (App gates the first paint on it); the
  // fallback only covers isolated test mounts.
  const defaultAgent = settings?.defaultAgent ?? "claude";
  const [agentType, setAgentType] = useState<AgentType>(defaultAgent);
  // The user picked a type by hand — that choice must survive a defaultAgent
  // change made in the settings dialog while this form is open ([F6]).
  const [agentTouched, setAgentTouched] = useState(false);
  const { agents } = useAgents();
  const agentOptions = selectableAgents(agents);
  const [count, setCount] = useState(1);
  // Empty string = no worktree isolation; maps to null in SpawnConfig.
  const [worktreeDir, setWorktreeDir] = useState("");
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

  // Once detection resolves, snap off an uninstalled default (e.g. a "codex"
  // preference when only OpenCode is installed) to the first selectable
  // agent ([F1]); the global preference still wins while it's selectable.
  useEffect(() => {
    if (agentOptions.length && !agentOptions.some((a) => a.id === agentType)) {
      setAgentType(defaultAgentType(agents, defaultAgent));
    }
    // Re-check only when the catalog changes, not on every manual pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  // Follow a defaultAgent CHANGE while the picker is untouched — the settings
  // dialog opens OVER this form (first run: the form is the only screen), so
  // a preference set there must reach the already-mounted form ([F6]). Acts
  // only on a real change (compared to the last seen value — idempotent under
  // StrictMode's double mount-effects): the initial state already honors the
  // preference, and at mount time the catalog is still empty, so re-deriving
  // then would clobber the initial pick with the bare fallback.
  const seenDefaultAgentRef = useRef(defaultAgent);
  useEffect(() => {
    if (seenDefaultAgentRef.current === defaultAgent) return;
    seenDefaultAgentRef.current = defaultAgent;
    if (!agentTouched) setAgentType(defaultAgentType(agents, defaultAgent));
    // A manual pick wins; re-derive only when the preference itself moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAgent]);

  // Esc closes the form when there's a workspace to return to — but not while
  // the nudge is open (its own Esc handles that, so the form stays put).
  useEscape(() => {
    if (onCancel && !nudge) onCancel();
  });

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

  const create = () => {
    if (cwd)
      onCreate({
        name,
        cwd,
        agentType,
        count,
        worktreeBaseDir: worktreeDir.trim() || null,
      });
  };

  const submit = () => {
    if (!cwd) return;
    // No worktree dir chosen but the working dir is a git repo → in-app nudge
    // (no system dialogs) before running every agent in one repo working tree.
    // Skipped for an empty workspace ([F15]): no agents run, nothing to isolate.
    if (count > 0 && !worktreeDir.trim() && git?.isRepo) {
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
            onClick={() => {
              setAgentTouched(true);
              setAgentType(a.id);
            }}
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
          disabled={!cwd}
          title={cwd ? "Create workspace" : "Choose a working directory first"}
        >
          Create workspace
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
