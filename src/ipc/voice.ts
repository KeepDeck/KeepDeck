import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  SpeechCapture,
  SpeechEngine,
  SpeechTranscript,
} from "@keepdeck/plugin-api";

/** Native speech delivery only. Model lifecycle belongs to the caller. */

/** A voice command's rejection as an `Error` whose `code` is the native
 * `{ kind, message }` kind — what `speechErrorKind` reads on the plugin side.
 * Anything else (a bare string, junk) still becomes a plain `Error`. */
export function speechError(raw: unknown): Error {
  if (typeof raw === "object" && raw !== null) {
    const { kind, message } = raw as { kind?: unknown; message?: unknown };
    if (typeof message === "string") {
      const error = new Error(message);
      if (typeof kind === "string") Object.assign(error, { code: kind });
      return error;
    }
  }
  return raw instanceof Error ? raw : new Error(String(raw));
}

function invokeVoice<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((raw: unknown) => {
    throw speechError(raw);
  });
}

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
  await invokeVoice("voice_capture_start", { captureId, pluginId, onLevel: channel });
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
  return invokeVoice<SpeechTranscript>("voice_capture_stop", {
    captureId,
    engine: opts.engine,
    modelPath: opts.modelPath,
    language: opts.language ?? null,
    prompt: opts.prompt ?? null,
  });
}

function voiceCaptureCancel(captureId: string): Promise<void> {
  return invokeVoice("voice_capture_cancel", { captureId });
}
