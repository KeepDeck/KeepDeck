/**
 * What the lifecycle machine's own state says about KeepDeck's work as a
 * whole: standing facts the person is told, not refusals of one ask.
 * - sessionsDown: the machine lost its sessions machine;
 * - stopped: the machine itself stopped.
 * In both, nothing starts or closes until KeepDeck restarts.
 */
export type Standing = "sessionsDown" | "stopped";

/** The standing facts a snapshot shows. That the machine stopped is never
 * one: a stopped machine sends no snapshot, and the page hears it apart. */
export function standingsOf(snapshot: { sessionsDown: boolean }): Standing[] {
  return snapshot.sessionsDown ? ["sessionsDown"] : [];
}
