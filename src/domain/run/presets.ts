import type { RunPreset, WorkspaceRun } from "../deck";

/**
 * Run presets — launch the app under development (experimental).
 *
 * The Run panel executes a workspace's preset as `$SHELL -c <command>` in a
 * chosen worktree — strictly OUTSIDE the agent world (its own session
 * manager, not panes). Everything is stack-agnostic by design: KeepDeck
 * injects a small env contract (worktree, branch, a deterministic port
 * block) and otherwise carries no semantics — a vite server, a gradle
 * install and a `go run` are all just commands. Inline env (`FOO=1 cmd`)
 * covers per-preset variables, so the schema stays minimal.
 *
 * The stored shape itself (RunPreset/WorkspaceRun and its tolerant read) is
 * the deck document's business — see deck/workspaceRun.ts; this module owns
 * what running means: the env contract and the preset-editing operations.
 * The experiment flag gates only the UI entry point — this module and
 * everything below it are flag-agnostic.
 */

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

/** Rewrite the preset with `id` in place (same id, same position); the SAME
 * object when it isn't present or the command trims empty. Name falls back
 * like [`addPreset`]'s. */
export function updatePreset(
  run: WorkspaceRun,
  id: string,
  name: string,
  command: string,
): WorkspaceRun {
  const trimmed = command.trim();
  if (!trimmed || !run.presets.some((p) => p.id === id)) return run;
  return {
    ...run,
    presets: run.presets.map((p) =>
      p.id === id
        ? { id, name: name.trim() || truncate(trimmed, 32), command: trimmed }
        : p,
    ),
  };
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

