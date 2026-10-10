import type { SpeechTranscript } from "@keepdeck/plugin-api";
import type { HistoryEntry } from "./controller";

/**
 * What a finished hold says in the history when it produced no text, or only
 * part of one. The native side decides WHAT happened (`silenceReason`,
 * `cutShort`); this decides the words — and nothing here re-judges the
 * measurements with thresholds of its own.
 */
export interface HoldLine {
  tone: HistoryEntry["tone"];
  text: string;
}

const seconds = (t: SpeechTranscript) => `${t.seconds.toFixed(1)}s`;

/** The line for a silent hold. */
export function describeSilence(t: SpeechTranscript): HoldLine {
  switch (t.silenceReason) {
    case "no-audio":
      return {
        tone: "error",
        text: `the microphone sent no audio${t.device ? ` (${t.device})` : ""} — check that it is connected and not in use`,
      };
    case "dead-signal":
      // Digital zero over a real hold is not a quiet user — the OS is
      // withholding the microphone. Name the actual fix.
      return {
        tone: "error",
        text: `the microphone delivered silence (${seconds(t)} of zeros) — check System Settings → Privacy & Security → Microphone; in dev the permission belongs to the terminal that launched the app`,
      };
    default:
      return { tone: "info", text: `didn't catch that (${seconds(t)})` };
  }
}

/** The line for a hold whose audio stopped before the key was released, or
 * `null` when it did not. */
export function describeCutShort(t: SpeechTranscript): HoldLine | null {
  if (!t.cutShort) return null;
  return {
    tone: "error",
    text: `the microphone stopped partway${t.device ? ` (${t.device})` : ""} — only the first ${seconds(t)} were heard`,
  };
}
