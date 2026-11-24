/**
 * The lifecycle's standing facts, told to the person: each once a run, as it
 * is first heard — from a snapshot, or from the machine's channel saying the
 * machine stopped. None of them goes away within a run, so none is told
 * twice.
 */
import { standingsOf, type Standing } from "../../domain/lifecycle";

export interface StandingAnnouncer {
  /** A snapshot of the machine: what it says about KeepDeck's work. */
  heard(snapshot: { sessionsDown: boolean }): void;
  /** The machine the page listens to stopped. */
  stopped(): void;
}

export function createStandingAnnouncer(say: (standing: Standing) => void): StandingAnnouncer {
  const said = new Set<Standing>();
  const once = (standing: Standing) => {
    if (said.has(standing)) return;
    said.add(standing);
    say(standing);
  };
  return {
    heard(snapshot) {
      for (const standing of standingsOf(snapshot)) once(standing);
    },
    stopped() {
      once("stopped");
    },
  };
}
