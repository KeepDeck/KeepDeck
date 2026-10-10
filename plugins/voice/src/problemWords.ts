import type { PluginNotifyInput } from "@keepdeck/plugin-api";
import type { VoiceProblem } from "./problems";

/**
 * The words for each problem — one place, read by both the notification and
 * the history line, so the two never say different things.
 */
export interface ProblemWords {
  title: string;
  body?: string;
  severity: NonNullable<PluginNotifyInput["severity"]>;
}

export interface ProblemFacts {
  /** The device the capture recorded from. */
  device?: string;
  /** Seconds of audio that arrived. */
  seconds?: number;
  /** The service's own message, for failures it explains best itself. */
  message?: string;
}

const PRIVACY = "Allow it in System Settings → Privacy & Security → Microphone; in dev the permission belongs to the terminal that launched the app.";

export function problemWords(problem: VoiceProblem, facts: ProblemFacts = {}): ProblemWords {
  const on = facts.device ? ` (${facts.device})` : "";
  switch (problem) {
    case "mic-missing":
      // Decision №3: just this — the recording went on from the default.
      return { title: "Microphone not connected", severity: "warning" };
    case "permission":
      return { title: "Microphone access is off", body: PRIVACY, severity: "error" };
    case "no-device":
      return { title: "No microphone found", body: "Connect a microphone and try again.", severity: "error" };
    case "device":
      return { title: "The microphone failed", body: facts.message, severity: "error" };
    case "no-audio":
      return {
        title: `The microphone sent no audio${on}`,
        body: "Check that it is connected and not in use.",
        severity: "error",
      };
    case "dead-signal":
      return {
        title: `The microphone delivered silence${on}`,
        body: `macOS is withholding it. ${PRIVACY}`,
        severity: "error",
      };
    case "cut-short":
      return {
        title: `The microphone stopped partway${on}`,
        body:
          facts.seconds === undefined
            ? undefined
            : `Only the first ${facts.seconds.toFixed(1)}s were heard.`,
        severity: "error",
      };
    case "clipping":
      return {
        title: `Input too loud${on}`,
        body: "The sound is distorting — turn the gain down on the microphone.",
        severity: "warning",
      };
    case "model-missing":
      return {
        title: "Speech model not installed",
        body: "Download one in Settings → Voice.",
        severity: "error",
      };
    case "engine":
      return { title: "Speech recognition failed", body: facts.message, severity: "error" };
  }
}

/** The one-line history form of the same words. */
export function problemLine(words: ProblemWords): string {
  return words.body ? `${words.title} — ${words.body}` : words.title;
}

/** The history line for a hold where nobody spoke — not a problem, so no
 * alert; just what happened. */
export function didNotCatchLine(seconds: number): string {
  return `didn't catch that (${seconds.toFixed(1)}s)`;
}
