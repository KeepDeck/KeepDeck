import type { HistoryEntry, VoiceMode, VoicePhase } from "./controller";
import type { VoiceModelInfo } from "./modelCatalog";

/**
 * What the Voice tab and the listening pill show for the controller's state
 * — the words and the choices, decided once. Components map these.
 */

/** What releasing the key does in this mode — dictation TYPES into the
 * input (it is never sent), a command RUNS. */
const releaseVerb = (mode: VoiceMode | null) => (mode === "dictation" ? "type" : "run");

/** The pill's label while something is in flight. */
export function pillLabel(phase: VoicePhase, mode: VoiceMode | null): string | null {
  switch (phase) {
    case "listening":
      return mode === "dictation"
        ? `Dictating — release to ${releaseVerb(mode)}`
        : `Listening — release to ${releaseVerb(mode)}`;
    case "transcribing":
      return "Transcribing…";
    case "idle":
      return null;
  }
}

/** The tab's status line while something is in flight. */
export function statusLine(phase: VoicePhase, mode: VoiceMode | null): string | null {
  switch (phase) {
    case "listening":
      return `listening — release to ${releaseVerb(mode)}, Esc cancels`;
    case "transcribing":
      return "transcribing — Esc discards";
    case "idle":
      return null;
  }
}

export interface ModelsState {
  /** null while the first read is in flight. */
  models: readonly VoiceModelInfo[] | null;
  error: string | null;
  downloading: boolean;
}

/** The tab's screen: the "get a model" prompt only when nothing is in
 * flight — a hold or a transcription keeps its Stop and its history even if
 * the last model is deleted meanwhile — and only once the models are known
 * and none is installed or arriving. */
export function tabScreen(phase: VoicePhase, state: ModelsState): "setup" | "main" {
  const noModel = state.models !== null && !state.models.some((m) => m.installed);
  return phase === "idle" && noModel && !state.downloading ? "setup" : "main";
}

/** A notice above the log when the model list could not be read: what went
 * wrong and a retry. Listening is pointless until it is read. */
export function modelsNotice(state: ModelsState): { text: string } | null {
  return state.error ? { text: `Couldn't read the speech models: ${state.error}` } : null;
}

export interface ListenControl {
  label: string;
  title: string;
  on: boolean;
  disabled: boolean;
}

/** The mic toggle: Listen / Stop, off while transcribing or while the model
 * list is unreadable. */
export function listenControl(phase: VoicePhase, chordLabel: string, state: ModelsState): ListenControl {
  const on = phase === "listening";
  return {
    label: on ? "◼ Stop" : "🎙 Listen",
    title: `Toggle command listening (or hold ${chordLabel})`,
    on,
    disabled: phase === "transcribing" || (!on && state.error !== null),
  };
}

export const TONE_GLYPH: Record<HistoryEntry["tone"], string> = {
  heard: "🗣",
  done: "✓",
  error: "✕",
  info: "…",
};

/** One history row: its text, or the copy flash replacing it for a moment. */
export function entryView(
  entry: HistoryEntry,
  flash: { ok: boolean } | null,
): { variant: "copied" | "failed" | null; text: string; title: string; glyph: string } {
  const variant = flash ? (flash.ok ? "copied" : "failed") : null;
  const label = variant === "copied" ? "Copied" : variant === "failed" ? "Copy failed" : null;
  return { variant, text: label ?? entry.text, title: label ?? "Click to copy", glyph: TONE_GLYPH[entry.tone] };
}
