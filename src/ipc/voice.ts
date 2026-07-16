import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  SpeechCapture,
  SpeechEngine,
  SpeechTranscript,
} from "@keepdeck/plugin-api";

/** Native speech delivery only. Model lifecycle belongs to the caller. */

export function voiceEngines(): Promise<SpeechEngine[]> {
  return invoke<SpeechEngine[]>("voice_engines");
}

export async function voiceCaptureStart(
  pluginId: string,
  onLevel: (rms: number) => void,
): Promise<SpeechCapture> {
  const captureId = crypto.randomUUID();
  const channel = new Channel<number>();
  channel.onmessage = onLevel;
  await invoke("voice_capture_start", { captureId, pluginId, onLevel: channel });
  let active = true;
  return {
    async stop(opts) {
      if (!active) throw new Error("speech capture is already closed");
      active = false;
      return voiceCaptureStop(captureId, opts);
    },
    async cancel() {
      if (!active) return;
      active = false;
      await voiceCaptureCancel(captureId);
    },
  };
}

function voiceCaptureStop(captureId: string, opts: {
  engine: SpeechEngine;
  modelPath: string;
  language?: string;
  prompt?: string;
}): Promise<SpeechTranscript> {
  return invoke<SpeechTranscript>("voice_capture_stop", {
    captureId,
    engine: opts.engine,
    modelPath: opts.modelPath,
    language: opts.language ?? null,
    prompt: opts.prompt ?? null,
  });
}

function voiceCaptureCancel(captureId: string): Promise<void> {
  return invoke("voice_capture_cancel", { captureId });
}
