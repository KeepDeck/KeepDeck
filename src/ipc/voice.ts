import { invoke, Channel } from "@tauri-apps/api/core";
import type { SpeechEngine } from "@keepdeck/plugin-api";

/** Native speech delivery only. Model lifecycle belongs to the caller. */

export interface TranscriptDto {
  text: string;
  /** The utterance was dropped as silence before inference. */
  silence: boolean;
  seconds: number;
  level: number;
}

export function voiceEngines(): Promise<SpeechEngine[]> {
  return invoke<SpeechEngine[]>("voice_engines");
}

export function voiceCaptureStart(onLevel: (rms: number) => void): Promise<void> {
  const channel = new Channel<number>();
  channel.onmessage = onLevel;
  return invoke("voice_capture_start", { onLevel: channel });
}

export function voiceCaptureStop(pluginId: string, opts: {
  engine: SpeechEngine;
  modelPath: string;
  language?: string;
  prompt?: string;
}): Promise<TranscriptDto> {
  return invoke<TranscriptDto>("voice_capture_stop", {
    pluginId,
    engine: opts.engine,
    modelPath: opts.modelPath,
    language: opts.language ?? null,
    prompt: opts.prompt ?? null,
  });
}

export function voiceCaptureCancel(): Promise<void> {
  return invoke("voice_capture_cancel");
}
