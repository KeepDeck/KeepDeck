/**
 * Which opencode a pane is about to run, read from what its binary answers
 * to `--version` (SpawnPlanInput.cliVersion).
 *
 * The host hands over the first dotted number of the answer (`1.19.3`,
 * `2.1.2` for `opencode v2.1.2`, measured, task-376); this reads its major
 * wherever it stands. Null when there is none: the host could not ask.
 */
export type Generation = 1 | 2;

export function opencodeGeneration(cliVersion: string | undefined): Generation | null {
  const major = /(\d+)\.\d+\.\d+/.exec(cliVersion ?? "")?.[1];
  if (major === undefined) return null;
  return Number(major) >= 2 ? 2 : 1;
}

/**
 * The generation a pane is launched, resumed and forked as — the one place
 * an unknown version gets its answer: it runs as 1.x, because 1.x exits on
 * 2.x's flags while 2.x merely lacks 1.x's extras, and a fork recipe of the
 * wrong generation fails at its first command rather than doing harm.
 */
export const generationOf = (cliVersion: string | undefined): Generation =>
  opencodeGeneration(cliVersion) ?? 1;
