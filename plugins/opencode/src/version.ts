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

/**
 * The flag that gives an opencode 2.x pane a server of its own.
 *
 * Without it every 2.x process on the machine joins one background service,
 * which loads KeepDeck's plugin once, with the environment of whichever pane
 * started it — so every other pane's reports would carry that pane's bridge.
 * 1.x has no such flag and EXITS on it (1.19.3, measured), so it is given
 * only to a release known to be 2.x; an unknown one runs as 1.x does.
 */
export const standaloneArgs = (cliVersion: string | undefined): string[] =>
  opencodeGeneration(cliVersion) === 2 ? ["--standalone"] : [];
