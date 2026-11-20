/**
 * What the lifecycle machine's own state says about KeepDeck's work as a
 * whole: standing facts the person is told, not refusals of one ask.
 * - viewOnly: another KeepDeck holds this settings folder, so this copy only
 *   shows;
 * - sessionsDown: the machine lost its sessions machine;
 * - stopped: the machine itself stopped.
 * In the last two, nothing starts or closes until KeepDeck restarts.
 */
export type Standing = "viewOnly" | "sessionsDown" | "stopped";

/** The standing facts a snapshot shows. That the machine stopped is never
 * one: a stopped machine sends no snapshot, and the page hears it apart. */
export function standingsOf(snapshot: { viewOnly: boolean; sessionsDown: boolean }): Standing[] {
  const standings: Standing[] = [];
  if (snapshot.viewOnly) standings.push("viewOnly");
  if (snapshot.sessionsDown) standings.push("sessionsDown");
  return standings;
}
