import { invoke, Channel } from "@tauri-apps/api/core";

/** The delivery layer for voice: whisper model management and push-to-talk
 * capture. Mirrors `src-tauri/src/voice.rs` one-to-one. */

export interface VoiceModelDto {
  id: string;
  label: string;
  sizeMb: number;
  installed: boolean;
  /** No working source anymore: an install keeps working, but there is
   * nothing to download — hide it when absent. */
  retired: boolean;
}

export interface DownloadProgressDto {
  received: number;
  total: number | null;
}

export interface TranscriptDto {
  text: string;
  /** The utterance was dropped as silence before inference. */
  silence: boolean;
  seconds: number;
  level: number;
}

export function voiceModelList(): Promise<VoiceModelDto[]> {
  return invoke<VoiceModelDto[]>("voice_model_list");
}

export function voiceModelDownload(
  id: string,
  onProgress: (p: DownloadProgressDto) => void,
): Promise<void> {
  const channel = new Channel<DownloadProgressDto>();
  channel.onmessage = onProgress;
  return invoke("voice_model_download", { id, onProgress: channel });
}

export function voiceModelDownloadCancel(id: string): Promise<void> {
  return invoke("voice_model_download_cancel", { id });
}

export function voiceModelDelete(id: string): Promise<void> {
  return invoke("voice_model_delete", { id });
}

export function voiceCaptureStart(onLevel: (rms: number) => void): Promise<void> {
  const channel = new Channel<number>();
  channel.onmessage = onLevel;
  return invoke("voice_capture_start", { onLevel: channel });
}

export function voiceCaptureStop(opts: {
  model: string;
  language?: string;
  prompt?: string;
}): Promise<TranscriptDto> {
  return invoke<TranscriptDto>("voice_capture_stop", {
    model: opts.model,
    language: opts.language ?? null,
    prompt: opts.prompt ?? null,
  });
}

export function voiceCaptureCancel(): Promise<void> {
  return invoke("voice_capture_cancel");
}
