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
