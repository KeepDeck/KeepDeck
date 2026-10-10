import type { SpeechLevel, SpeechTranscript } from "@keepdeck/plugin-api";
import { CLIPPING_RATIO } from "./problems";
import { offsetWarning, problemWords, quietWarning } from "./problemWords";

/**
 * The microphone's health as the Voice tab and the listening pill show it —
 * one derivation for both (they used to compute the meter separately). The
 * native side measured everything; this only decides what it looks like.
 */

/** The meter's floor: below −60 dBFS is a quiet room, an empty bar. */
const METER_FLOOR_DB = -60;
/** A reading older than this is not live — the device stopped delivering. */
export const FRESH_MS = 300;
/** …and the bar falls to empty over this long after that, never sticking. */
const DECAY_MS = 700;
/** A constant offset this large is a faulty device or driver state; the
 * user's BY-PM700 sits at ~0.02 right after a replug and drifts to 0.30. */
export const OFFSET_WARN = 0.05;
/** A spoken hold that never peaked above this is too quiet to recognise
 * reliably — the input gain is low. */
export const QUIET_PEAK = 0.05;

export type MicWarningKind = "offset" | "clipping" | "quiet" | "silent";

export interface MicWarning {
  kind: MicWarningKind;
  text: string;
}

export interface MicStatus {
  /** The meter's fill, 0..100, on a −60..0 dBFS scale. */
  meter: number;
  /** A reading arrived within FRESH_MS. */
  live: boolean;
  /** The device the current or last capture used. */
  device: string | null;
  warnings: MicWarning[];
}

export interface MicFacts {
  listening: boolean;
  device: string | null;
  reading: SpeechLevel | null;
  /** When `reading` arrived (ms). */
  readingAt: number;
  lastHold: SpeechTranscript | null;
}

/** RMS as the meter's fill: dBFS mapped linearly from −60 (empty) to 0. */
export function meterPercent(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.round(Math.min(100, Math.max(0, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100)));
}

export function micStatus(facts: MicFacts, now: number): MicStatus {
  const age = now - facts.readingAt;
  const live = facts.listening && facts.reading !== null && age <= FRESH_MS;
  const fade = facts.listening ? Math.max(0, 1 - Math.max(0, age - FRESH_MS) / DECAY_MS) : 0;
  return {
    meter: facts.reading ? Math.round(meterPercent(facts.reading.rms) * fade) : 0,
    live,
    device: facts.device,
    warnings: warnings(facts),
  };
}

function warnings({ reading, lastHold, device }: MicFacts): MicWarning[] {
  const out: MicWarning[] = [];
  const offset = reading?.dcOffset ?? lastHold?.dcOffset ?? 0;
  if (Math.abs(offset) >= OFFSET_WARN) {
    out.push({ kind: "offset", text: offsetWarning(offset) });
  }
  const clipping = reading?.clipped || (lastHold?.clippedRatio ?? 0) >= CLIPPING_RATIO;
  if (clipping) {
    const words = problemWords("clipping", { device: device ?? undefined });
    out.push({ kind: "clipping", text: `${words.title}. ${words.body}` });
  }
  if (lastHold?.silenceReason === "no-audio" || lastHold?.silenceReason === "dead-signal") {
    out.push({ kind: "silent", text: problemWords(lastHold.silenceReason, { device: device ?? undefined }).title });
  } else if (lastHold && !lastHold.silence && lastHold.peak < QUIET_PEAK) {
    out.push({ kind: "quiet", text: quietWarning() });
  }
  return out;
}
