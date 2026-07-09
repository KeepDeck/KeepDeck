/**
 * Per-pane count of ACCEPTED bridge postbacks (token-verified session
 * reports). Module scope, like the spawn-spec cache it works with.
 *
 * The one consumer is the resume-failure detector: a resume spawn that
 * exits WITHOUT having produced a single postback never became a session
 * (`--resume` of an id whose conversation the CLI can't find prints an
 * error and exits) — whereas a resume that worked always reports first
 * (every agent's startup hook posts through the bridge). Comparing the
 * count at plan-build time against the count at exit time turns "did the
 * resume actually start?" into plain arithmetic — no timers, no store
 * reads.
 */
const counts = new Map<string, number>();

export function bumpPostback(paneId: string): void {
  counts.set(paneId, (counts.get(paneId) ?? 0) + 1);
}

export function postbackCount(paneId: string): number {
  return counts.get(paneId) ?? 0;
}

/** Test isolation. */
export function resetPostbacks(): void {
  counts.clear();
}
