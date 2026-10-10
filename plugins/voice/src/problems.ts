import { speechErrorKind, type SpeechTranscript } from "@keepdeck/plugin-api";

/**
 * What can go wrong with voice input that the user must hear about, judged
 * from what the speech service reports — never re-measured here. Each
 * problem is one notification tag: it is announced when it appears and stays
 * quiet until a later step shows it gone (see `alerts`).
 */
export type VoiceProblem =
  | "mic-missing"
  | "permission"
  | "no-device"
  | "device"
  | "no-audio"
  | "dead-signal"
  | "cut-short"
  | "clipping"
  | "model-missing"
  | "engine";

/** Problems a capture START can show or clear. */
export const START_PROBLEMS: readonly VoiceProblem[] = [
  "mic-missing",
  "permission",
  "no-device",
  "device",
];

/** Problems a finished HOLD can show or clear. */
export const HOLD_PROBLEMS: readonly VoiceProblem[] = [
  "no-audio",
  "dead-signal",
  "cut-short",
  "clipping",
  "model-missing",
  "engine",
];

/** A hold whose raw samples hit the ceiling at least this often distorted
 * audibly — measured: speech at full input gain clipped ~1% of samples. */
export const CLIPPING_RATIO = 0.001;

/** The problem a failed speech call stands for, or null for one the user
 * cannot act on (busy, a closed handle, an internal fault). */
export function problemOfError(error: unknown): VoiceProblem | null {
  switch (speechErrorKind(error)) {
    case "permission":
      return "permission";
    case "no-device":
      return "no-device";
    case "device":
    case "unsupported-format":
      return "device";
    case "model-missing":
      return "model-missing";
    case "engine":
      return "engine";
    default:
      return null;
  }
}

/** Every problem a finished hold shows. */
export function holdProblems(t: SpeechTranscript): VoiceProblem[] {
  const problems: VoiceProblem[] = [];
  if (t.silenceReason === "no-audio") problems.push("no-audio");
  if (t.silenceReason === "dead-signal") problems.push("dead-signal");
  if (t.cutShort) problems.push("cut-short");
  if (t.clippedRatio >= CLIPPING_RATIO) problems.push("clipping");
  return problems;
}
