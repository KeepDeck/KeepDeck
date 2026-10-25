import {
  blockingIssue,
  chordFromEvent,
  DEFAULT_BINDINGS,
  formatChord,
  isModifierKey,
  standingIssue,
  withSlot,
  type KeyLike,
  type VoiceBindings,
} from "./binding";
import { keyList } from "@keepdeck/plugin-api";

/**
 * The hotkey editor's decisions: what a key press does while a row is
 * recording, and what each row shows. The component holds which row is
 * recording and the last rejection; everything else is decided here.
 */

type Slot = keyof VoiceBindings;

/** Copy per bindable slot. A Record, not a list: add a slot to VoiceBindings
 * and this stops compiling until the slot has a row, instead of quietly
 * shipping a binding the user cannot reach. */
const ROW_COPY: Record<Slot, { label: string; hint: string }> = {
  command: { label: "Command", hint: "Hold to speak a deck command" },
  dictation: { label: "Dictation", hint: "Hold to dictate into the focused agent" },
};

/** What one key press means to a row that is recording. */
export type RecorderStep =
  /** Escape: stop recording, change nothing. */
  | { kind: "cancel" }
  /** A modifier alone: keep waiting for the main key. */
  | { kind: "wait" }
  /** A chord that cannot be bound here; stay recording. */
  | { kind: "reject"; message: string }
  /** Bind it: the bindings to write. */
  | { kind: "accept"; bindings: VoiceBindings };

export function recorderStep(slot: Slot, e: KeyLike, bindings: VoiceBindings): RecorderStep {
  if (e.key === "Escape") return { kind: "cancel" };
  if (isModifierKey(e.key)) return { kind: "wait" };
  const next = chordFromEvent(e);
  const blocking = blockingIssue(slot, next, bindings);
  if (blocking) return { kind: "reject", message: blocking };
  return { kind: "accept", bindings: withSlot(bindings, slot, next) };
}

/** The bindings with one slot back at its default. */
export function resetSlot(bindings: VoiceBindings, slot: Slot): VoiceBindings {
  return withSlot(bindings, slot, DEFAULT_BINDINGS[slot]);
}

/** The fixed words of the hotkey editor. */
export const HOTKEYS_TEXT = {
  intro:
    "Hold a chord to talk, release to run a command or fill in dictation. Click a shortcut and press a new combination to rebind it; Escape cancels recording.",
  reset: "Reset",
  resetTitle: "Reset to default",
} as const;

export interface HotkeyRow {
  slot: Slot;
  label: string;
  hint: string;
  /** The chord control's accessible name. */
  ariaLabel: string;
  /** The chord, or the prompt while recording. */
  chordText: string;
  recording: boolean;
  /** The rejection while recording, else a standing issue with the chord. */
  message: { tone: "error" | "warn"; text: string } | null;
}

export function hotkeyRows(
  bindings: VoiceBindings,
  recording: Slot | null,
  rejection: string | null,
): HotkeyRow[] {
  return keyList<typeof ROW_COPY>()(["command", "dictation"]).map((slot) => {
    const isRecording = recording === slot;
    const issue = isRecording ? null : standingIssue(slot, bindings);
    return {
      slot,
      ...ROW_COPY[slot],
      ariaLabel: `${ROW_COPY[slot].label} shortcut`,
      chordText: isRecording ? "Press keys…" : formatChord(bindings[slot]),
      recording: isRecording,
      message:
        isRecording && rejection
          ? { tone: "error", text: rejection }
          : issue
            ? { tone: issue.severity === "error" ? "error" : "warn", text: issue.message }
            : null,
    };
  });
}
