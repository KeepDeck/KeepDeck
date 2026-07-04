/**
 * Run presets — launch the app under development in a pane (experimental).
 *
 * A workspace owns named shell commands ("presets") plus an optional one-time
 * `setup` command; a pane launched from one runs `$SHELL -c <command>` in its
 * worktree. Everything is stack-agnostic by design: KeepDeck injects a small
 * env contract (worktree, branch, a deterministic port block) and otherwise
 * carries no semantics — a vite server, a gradle install and a `go run` are
 * all just commands. Inline env (`FOO=1 cmd`) covers per-preset variables, so
 * the schema stays minimal.
 *
 * Presets live on the workspace (persisted with the deck): deleting the
 * workspace deletes them structurally, and panes inherit their workspace's
 * list. The experiment flag gates only the UI entry points — this module and
 * everything below it are flag-agnostic.
 */

/** One named launch command of a workspace. */
export interface RunPreset {
  /** Stable id (`run-N` within the workspace) — what a pane records. */
  id: string;
  name: string;
  /** The shell command line, run via `$SHELL -c` in the pane's worktree. */
  command: string;
}

/** A workspace's run configuration. */
export interface WorkspaceRun {
  /** One-time worktree-preparation command (deps, .env copies), executed by
   * the provisioning flow after `worktree_create`; failure → the Retry card. */
  setup?: string;
  presets: RunPreset[];
}

/** What a run pane remembers about its command. */
export interface PaneRun {
  /** The preset this command came from; an ad-hoc run has none. */
  presetId?: string;
  /** The command line snapshot at launch — later preset edits don't rewrite
   * a pane that is already running (or dormant, awaiting revive). */
  command: string;
}

/** Env every run/setup command receives. `port` is the base of the pane's
 * 10-port block (`ports_allocate`); absent while allocation is unavailable —
 * a preset that needs it fails visibly in its own terminal rather than
 * silently binding a default. */
export function runEnv(location: {
  worktree: string;
  branch?: string;
  port?: number;
}): [string, string][] {
  const env: [string, string][] = [["KEEPDECK_WORKTREE", location.worktree]];
  if (location.branch) env.push(["KEEPDECK_BRANCH", location.branch]);
  if (location.port !== undefined) env.push(["KEEPDECK_PORT", String(location.port)]);
  return env;
}

/** Append a preset named `name` running `command`, minting the next `run-N`
 * id. Blank name falls back to the command itself (truncated) — the picker's
 * save path allows skipping the name field. */
export function addPreset(
  run: WorkspaceRun | undefined,
  name: string,
  command: string,
): WorkspaceRun {
  const presets = run?.presets ?? [];
  const preset: RunPreset = {
    id: `run-${maxRunSeq(presets) + 1}`,
    name: name.trim() || truncate(command.trim(), 32),
    command: command.trim(),
  };
  return { ...run, presets: [...presets, preset] };
}

/** Remove the preset with `id`; the SAME object when it isn't present. */
export function removePreset(run: WorkspaceRun, id: string): WorkspaceRun {
  if (!run.presets.some((p) => p.id === id)) return run;
  return { ...run, presets: run.presets.filter((p) => p.id !== id) };
}

/** Set (or clear, with blank) the workspace's one-time setup command. */
export function setSetup(
  run: WorkspaceRun | undefined,
  setup: string,
): WorkspaceRun {
  const presets = run?.presets ?? [];
  const trimmed = setup.trim();
  if (!trimmed) {
    const { setup: _gone, ...rest } = run ?? { presets };
    return { ...rest, presets };
  }
  return { ...run, presets, setup: trimmed };
}

/**
 * Tolerant read of a persisted workspace-run value: `null` for a shape that
 * isn't one (the workspace simply has no run config), and individually
 * malformed presets are dropped rather than rejecting the deck — mirroring
 * how persist degrades an unknown agentType. Always parsed regardless of the
 * experiment flag: turning the experiment off must never drop stored data on
 * the next save.
 */
export function readWorkspaceRun(value: unknown): WorkspaceRun | null {
  if (!isRecord(value) || !Array.isArray(value.presets)) return null;
  const presets: RunPreset[] = [];
  for (const p of value.presets) {
    if (
      isRecord(p) &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      typeof p.command === "string" &&
      p.command.trim() !== ""
    ) {
      presets.push({ id: p.id, name: p.name, command: p.command });
    }
  }
  const run: WorkspaceRun = { presets };
  if (typeof value.setup === "string" && value.setup.trim() !== "") {
    run.setup = value.setup;
  }
  return run;
}

/** Tolerant read of a persisted pane-run value: `null` degrades the pane to
 * a plain one (same spirit as [`readWorkspaceRun`]). */
export function readPaneRun(value: unknown): PaneRun | null {
  if (!isRecord(value) || typeof value.command !== "string") return null;
  if (value.command.trim() === "") return null;
  const run: PaneRun = { command: value.command };
  if (typeof value.presetId === "string") run.presetId = value.presetId;
  return run;
}

/** Highest `run-N` among the presets (0 when none — ids start at `run-1`). */
function maxRunSeq(presets: RunPreset[]): number {
  let max = 0;
  for (const p of presets) {
    const m = /^run-(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
