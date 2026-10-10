/** Native local speech-to-text mechanism. Model catalog and lifecycle stay in plugins. */
export type SpeechEngine = "whisper" | "parakeet";

/** Why a hold produced no text. */
export type SpeechSilenceReason =
  /** The device delivered no audio at all. */
  | "no-audio"
  /** Audio arrived as digital zero — the OS withholds the microphone
   * (on macOS: the privacy permission). */
  | "dead-signal"
  /** Real audio, nobody spoke (or the model heard nothing to write). */
  | "no-speech";

export interface SpeechTranscript {
  text: string;
  /** Nothing was transcribed; `silenceReason` says why. */
  silence: boolean;
  /** Set exactly when `silence` is. */
  silenceReason: SpeechSilenceReason | null;
  seconds: number;
  /** RMS of the whole hold, after the device's constant offset is removed. */
  level: number;
  /** Largest raw magnitude in the hold, 0..1. */
  peak: number;
  /** Share of raw samples that hit the converter's ceiling, 0..1 — the
   * sound distorted (input gain too high). */
  clippedRatio: number;
  /** The constant offset the device added (signed). Normal microphones sit
   * at ~0; a large one means a faulty device or driver. */
  dcOffset: number;
  /** The device the audio came from, as the OS names it. */
  device: string;
  /** The audio stopped arriving before the key was released — the device
   * was unplugged or its stream died mid-hold; the text covers only the
   * part that arrived. */
  cutShort: boolean;
}

/** What the microphone measured in one moment of a capture (~30 per
 * second while listening). */
export interface SpeechLevel {
  /** Loudness after the device's constant offset is removed, as RMS 0..1. */
  rms: number;
  /** Largest raw magnitude, 0..1. */
  peak: number;
  /** Whether the sound hit the converter's ceiling (distorted). */
  clipped: boolean;
  /** The constant offset the device is adding right now (signed). */
  dcOffset: number;
}

export interface SpeechCaptureOptions {
  engine: SpeechEngine;
  /** Relative path in this plugin's private download directory. */
  modelPath: string;
  language?: string;
  prompt?: string;
}

/**
 * Why a speech call failed, as something a plugin can act on — the message is
 * prose for a human. A rejected `startCapture`, `stop` or `cancel` carries
 * the kind as the error's `code`; read it with `speechErrorKind`. The host
 * holds this list equal to its native one (a test on each side).
 */
export const SPEECH_ERROR_KINDS = [
  "permission",
  "no-device",
  "device",
  "unsupported-format",
  "busy",
  "no-capture",
  "model-missing",
  "engine",
  "internal",
] as const;

export type SpeechErrorKind = (typeof SPEECH_ERROR_KINDS)[number];

/** The kind of a rejected speech call, or `null` for an error that carries
 * none (a host older than the kinds, or a failure outside the speech tier). */
export function speechErrorKind(error: unknown): SpeechErrorKind | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return (SPEECH_ERROR_KINDS as readonly unknown[]).includes(code)
    ? (code as SpeechErrorKind)
    : null;
}

/** One microphone the OS offers. */
export interface SpeechDevice {
  /** Stable across restarts and replugs — what a saved choice is kept as. */
  id: string;
  /** The name the OS shows ("MacBook Pro Microphone"). */
  name: string;
  /** The system's current default input. */
  isDefault: boolean;
}

export interface SpeechStartOptions {
  /** Record from this device (a `SpeechDevice.id`). Absent: the system
   * default. A device that is not connected does NOT fail the start — the
   * capture records from the default and says so in `deviceMissing`. */
  deviceId?: string;
}

export interface SpeechCapture {
  /** The name of the device this capture records from. */
  readonly device: string;
  /** A device was asked for but is not connected; this capture records
   * from the system default instead. */
  readonly deviceMissing: boolean;
  stop(opts: SpeechCaptureOptions): Promise<SpeechTranscript>;
  cancel(): Promise<void>;
}

export interface PluginSpeech {
  /** Engines compiled into this host build; carries no model catalog. */
  engines(): Promise<SpeechEngine[]>;
  /** The microphones connected right now, default first — read on request,
   * nothing is watched in the background. */
  devices(): Promise<SpeechDevice[]>;
  /** The returned handle is the sole authority over this capture. */
  startCapture(
    onLevel?: (rms: number, level: SpeechLevel) => void,
    options?: SpeechStartOptions,
  ): Promise<SpeechCapture>;
}
