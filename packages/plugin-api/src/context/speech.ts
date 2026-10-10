/** Native local speech-to-text mechanism. Model catalog and lifecycle stay in plugins. */
export type SpeechEngine = "whisper" | "parakeet";

export interface SpeechTranscript {
  text: string;
  silence: boolean;
  seconds: number;
  level: number;
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

export interface SpeechCapture {
  stop(opts: SpeechCaptureOptions): Promise<SpeechTranscript>;
  cancel(): Promise<void>;
}

export interface PluginSpeech {
  /** Engines compiled into this host build; carries no model catalog. */
  engines(): Promise<SpeechEngine[]>;
  /** The returned handle is the sole authority over this capture. */
  startCapture(onLevel?: (rms: number) => void): Promise<SpeechCapture>;
}
