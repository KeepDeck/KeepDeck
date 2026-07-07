/**
 * Run presets — launch the app under development.
 *
 * The Run plugin executes a workspace's preset as `$SHELL -c <command>` in a
 * chosen worktree — strictly OUTSIDE the agent world (its own session manager,
 * not panes). Everything is stack-agnostic by design: KeepDeck injects a small
 * env contract (worktree, branch, a deterministic port block) and otherwise
 * carries no semantics — a vite server, a gradle install and a `go run` are all
 * just commands. Inline env (`FOO=1 cmd`) covers per-preset variables, so the
 * shape stays minimal.
 *
 * The plugin OWNS this preset shape now: it lives in the plugin's per-workspace
 * storage slot (a plain `RunPreset[]`), not in the host deck document. This
 * module owns what running means — the env contract — and the pure preset-list
 * edits behind the panel's add / edit / delete.
 */

/** One named launch command of a workspace. */
export interface RunPreset {
  /** Stable id (`run-N` within the workspace). */
  id: string;
  name: string;
  /** The shell command line, run via `$SHELL -c` in the chosen worktree. */
  command: string;
}

/** Env every run command receives. `port` is the base of the target's 10-port
 * block (`ports.allocate`); absent while allocation is unavailable — a preset
 * that needs it fails visibly in its own terminal rather than silently binding
 * a default. */
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
 * save path allows skipping the name field.
 *
 * `reservedIds` are ids still held by live sessions whose preset row may
 * already be gone (delete-while-running leaves an orphan session): minting must
 * clear those too, or a re-minted id would rebind a running command to the new,
 * unrelated preset row. */
export function addPreset(
  presets: readonly RunPreset[],
  name: string,
  command: string,
  reservedIds: readonly string[] = [],
): RunPreset[] {
  const taken = [...presets.map((p) => p.id), ...reservedIds];
  const preset: RunPreset = {
    id: `run-${maxRunSeq(taken) + 1}`,
    name: name.trim() || truncate(command.trim(), 32),
    command: command.trim(),
  };
  return [...presets, preset];
}

/** Remove the preset with `id`; the SAME array when it isn't present. */
export function removePreset(
  presets: readonly RunPreset[],
  id: string,
): RunPreset[] {
  if (!presets.some((p) => p.id === id)) return presets as RunPreset[];
  return presets.filter((p) => p.id !== id);
}

/** Rewrite the preset with `id` in place (same id, same position); the SAME
 * array when it isn't present or the command trims empty. Name falls back like
 * [`addPreset`]'s. */
export function updatePreset(
  presets: readonly RunPreset[],
  id: string,
  name: string,
  command: string,
): RunPreset[] {
  const trimmed = command.trim();
  if (!trimmed || !presets.some((p) => p.id === id)) return presets as RunPreset[];
  return presets.map((p) =>
    p.id === id
      ? { id, name: name.trim() || truncate(trimmed, 32), command: trimmed }
      : p,
  );
}

/** Highest `run-N` among a set of ids (0 when none — ids start at `run-1`). */
function maxRunSeq(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    const m = /^run-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
