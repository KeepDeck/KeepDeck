import type { PluginNotify } from "@keepdeck/plugin-api";
import type { VoiceProblem } from "./problems";
import type { ProblemWords } from "./problemWords";

/**
 * Turns problems into notifications without spam (decision №4): each problem
 * is announced once when it appears, under its own tag; while it persists,
 * nothing more is sent; once a step that could show it comes back without
 * it, it is forgotten — and announced again if it ever returns.
 */
export interface VoiceAlerts {
  /** One step's verdict: of the problems this step can show (`scope`),
   * exactly `present` are true now. */
  update(scope: readonly VoiceProblem[], present: ReadonlyMap<VoiceProblem, ProblemWords>): void;
}

export function createVoiceAlerts(notify: PluginNotify): VoiceAlerts {
  const raised = new Set<VoiceProblem>();
  return {
    update(scope, present) {
      for (const problem of scope) {
        const words = present.get(problem);
        if (!words) {
          raised.delete(problem);
          continue;
        }
        if (raised.has(problem)) continue;
        raised.add(problem);
        notify({
          title: words.title,
          body: words.body,
          severity: words.severity,
          tag: problem,
          dockTab: "voice",
        });
      }
    },
  };
}
