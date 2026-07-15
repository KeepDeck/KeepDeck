/** Native local speech-to-text mechanism. Model catalog and lifecycle stay in plugins. */
export type SpeechEngine = "whisper" | "parakeet";

export interface SpeechTranscript {
  text: string;
  silence: boolean;
  seconds: number;
  level: number;
}

export interface PluginSpeech {
  /** Engines compiled into this host build; carries no model catalog. */
  engines(): Promise<SpeechEngine[]>;
  startCapture(onLevel?: (rms: number) => void): Promise<void>;
  stopCapture(opts: {
    engine: SpeechEngine;
    /** Relative path in this plugin's private download directory. */
    modelPath: string;
    language?: string;
    prompt?: string;
  }): Promise<SpeechTranscript>;
  cancelCapture(): Promise<void>;
}
