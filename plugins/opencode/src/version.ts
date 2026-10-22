/**
 * Which opencode a pane is about to run, read from what its binary answers
 * to `--version` (SpawnPlanInput.cliVersion).
 *
 * The host hands over the first dotted number of the answer (`1.19.3`,
 * `2.1.2` for `opencode v2.1.2`, measured, task-376); this reads its major
 * wherever it stands. Null when there is none: the host could not ask.
 */
export function opencodeGeneration(cliVersion: string | undefined): 1 | 2 | null {
  const major = /(\d+)\.\d+\.\d+/.exec(cliVersion ?? "")?.[1];
  if (major === undefined) return null;
  return Number(major) >= 2 ? 2 : 1;
}
