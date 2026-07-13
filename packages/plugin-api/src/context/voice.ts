/**
 * Local voice services — microphone capture and on-device speech-to-text,
 * gated by the `mic` capability (consent names the microphone explicitly).
 *
 * The shape is push-to-talk: `startCapture` opens the mic (the OS consent
 * prompt fires here on first use), `stopCapture` closes it and returns the
 * whole utterance transcribed by a LOCAL whisper model — audio never leaves
 * the machine. Models are downloaded on demand through the same service and
 * shared by every plugin; nothing is bundled.
 */
export interface VoiceModelInfo {
  id: string;
  label: string;
  sizeMb: number;
  installed: boolean;
  /** No working source anymore: an existing install keeps transcribing and
   * can be deleted, but nothing can be downloaded — hide it when absent. */
  retired: boolean;
}

export interface VoiceDownloadProgress {
  received: number;
  /** Total bytes when the server said; null while unknown. */
  total: number | null;
}

export interface VoiceTranscript {
  text: string;
  /** The utterance was dropped as silence before inference — say "didn't
   * catch that", don't act on the empty text. */
  silence: boolean;
  /** Captured length in seconds; 0 means the mic delivered nothing. */
  seconds: number;
  /** RMS level of the utterance. A nonzero duration with a ~0 level means
   * the OS is delivering silence — the microphone permission is the usual
   * culprit; surface that, don't just shrug. */
  level: number;
}

export interface PluginVoice {
  /** The downloadable model registry with per-model install state. */
  models(): Promise<VoiceModelInfo[]>;
  /** Download one model with streamed progress; resolves when installed.
   * Already-installed ids resolve immediately. */
  downloadModel(
    id: string,
    onProgress?: (p: VoiceDownloadProgress) => void,
  ): Promise<void>;
  /** Stop an in-flight download; the partial file stays and the next
   * `downloadModel` resumes where it stopped. The pending `downloadModel`
   * promise rejects with the message `"cancelled"` — a quiet reset, not an
   * error to paint red. */
  cancelDownload(id: string): Promise<void>;
  deleteModel(id: string): Promise<void>;
  /** Open the mic and start accumulating one utterance. `onLevel` receives
   * a coarse RMS reading (~30 fps) for a live meter. One capture at a time,
   * app-wide. */
  startCapture(onLevel?: (rms: number) => void): Promise<void>;
  /** Close the mic and transcribe the utterance with `model`. `language`
   * pins a whisper code ("en", "ru"); omit for auto-detect. `prompt` biases
   * recognition toward known vocabulary — pass workspace/branch names and
   * command words. */
  stopCapture(opts: {
    model: string;
    language?: string;
    prompt?: string;
  }): Promise<VoiceTranscript>;
  /** Drop the capture without transcribing. */
  cancelCapture(): Promise<void>;
}
