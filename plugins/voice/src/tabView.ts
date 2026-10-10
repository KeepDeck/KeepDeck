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

/** The fixed words of the Voice tab. */
export const TAB_TEXT = {
  setupTitle: "No speech model yet",
  setupText:
    "Voice commands and dictation need a local speech-to-text model. Download one to get started — it stays on your machine.",
  setupAction: "Choose a model…",
  helpLabel: "How to use voice",
  clear: "Clear",
  clearTitle: "Clear the history",
} as const;

/** The empty log's hint, as parts the component lays out: text, a chord in
 * a key cap, and the info glyph. */
export type HintPart = { text: string } | { chord: string } | { info: true };

export function emptyHint(commandChord: string, dictationChord: string): HintPart[] {
  return [
    { text: "Hold " },
    { chord: commandChord },
    { text: " and say a command, or " },
    { chord: dictationChord },
    { text: " to dictate. Hover " },
    { info: true },
    { text: " for the list." },
  ];
}

/** Clear is offered for a history that exists, and only when nothing is in
 * flight (a hold's own lines are still arriving). */
export function canClear(phase: VoicePhase, historyLength: number): boolean {
  return phase === "idle" && historyLength > 0;
}

/** The listening pill: hidden when idle; the live dot while the mic is
 * open, and the microphone recording once it is known. Whether its meter
 * shows is the mic status's call (`showMeter`), the same one the tab reads. */
export function pillView(
  phase: VoicePhase,
  mode: VoiceMode | null,
  device: string | null,
): { visible: boolean; live: boolean; label: string | null; device: string | null } {
  return {
    visible: phase !== "idle",
    live: phase === "listening",
    label: pillLabel(phase, mode),
    device: phase === "listening" ? device : null,
  };
}
