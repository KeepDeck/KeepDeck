import { useEffect, useState, useSyncExternalStore } from "react";
import type { CustomSettingsFieldProps } from "@keepdeck/plugin-api";
import {
  chordFromEvent,
  DEFAULT_BINDINGS,
  formatChord,
  HOTKEYS_KEY,
  isModifierKey,
  validateChord,
  type VoiceBindings,
} from "../binding";
import { runtime } from "../runtime";

/**
 * The push-to-talk hotkey editor, rendered inside the plugin's settings page (a
 * `custom` field — the declarative vocabulary has no key recorder). Two rows,
 * Command and Dictation: click a shortcut, press a combination, and it's
 * captured and validated. Any chord is allowed; one with no ⌥/⌃/⌘ modifier is
 * kept but flagged, since the in-app handler swallows it from the terminal.
 * Escape is reserved for cancelling and can't be bound.
 *
 * Display reads the shared bindings store (one truth with the handler and the
 * help copy); a pick persists through the host `write`, which round-trips back
 * to the store, so the row updates on its own.
 */
const ROWS: { slot: keyof VoiceBindings; label: string; hint: string }[] = [
  { slot: "command", label: "Command", hint: "Hold to speak a deck command" },
  {
    slot: "dictation",
    label: "Dictation",
    hint: "Hold to dictate into the focused agent",
  },
];

export function HotkeysSection({ write }: CustomSettingsFieldProps) {
  const { bindings: store } = runtime();
  const bindings = useSyncExternalStore(store.subscribe, store.snapshot);
  // Which row is capturing, if any — only one at a time; the error is the last
  // rejected attempt for that row.
  const [recording, setRecording] = useState<keyof VoiceBindings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    // Silence push-to-talk for the duration, so the keys we're capturing don't
    // also fire a command or dictation.
    const { recordingLatch } = runtime();
    recordingLatch.begin();
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      // Wait for the main key — a chord is modifiers PLUS one key.
      if (isModifierKey(e.key)) return;
      const next = chordFromEvent(e);
      const blocking = validateChord(recording, next, bindings).find(
        (i) => i.severity === "error",
      );
      if (blocking) {
        setError(blocking.message);
        return; // stay recording; let the user try another chord
      }
      write(HOTKEYS_KEY, { ...bindings, [recording]: next });
      setError(null);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      recordingLatch.end();
    };
  }, [recording, bindings, write]);

  const reset = (slot: keyof VoiceBindings): void => {
    setError(null);
    setRecording(null);
    write(HOTKEYS_KEY, { ...bindings, [slot]: DEFAULT_BINDINGS[slot] });
  };

  return (
    <div className="voice-hotkeys">
      <div className="voice-hotkeys__intro">
        Hold a chord to talk, release to run or send. Click a shortcut and press
        a new combination to rebind it; Escape cancels recording.
      </div>
      {ROWS.map((row) => {
        const isRecording = recording === row.slot;
        const warning = warningFor(row.slot, bindings);
        return (
          <div key={row.slot} className="voice-hotkeys__row">
            <div className="voice-hotkeys__labels">
              <span className="voice-hotkeys__label">{row.label}</span>
              <span className="voice-hotkeys__hint">{row.hint}</span>
            </div>
            <div className="voice-hotkeys__controls">
              <button
                type="button"
                className={`voice-hotkeys__chord${isRecording ? " voice-hotkeys__chord--recording" : ""}`}
                onClick={() => {
                  setError(null);
                  setRecording(isRecording ? null : row.slot);
                }}
                aria-label={`${row.label} shortcut`}
              >
                {isRecording ? "Press keys…" : formatChord(bindings[row.slot])}
              </button>
              <button
                type="button"
                className="voice-hotkeys__reset"
                onClick={() => reset(row.slot)}
                title="Reset to default"
              >
                Reset
              </button>
            </div>
            {isRecording && error && (
              <div className="voice-hotkeys__error">{error}</div>
            )}
            {!isRecording && warning && (
              <div className="voice-hotkeys__warn">{warning}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The standing warning for a persisted chord (a modifier-less binding), or
 * null. The duplicate/Escape errors can't apply to an already-persisted state,
 * so only warnings surface here. */
function warningFor(
  slot: keyof VoiceBindings,
  bindings: VoiceBindings,
): string | null {
  const w = validateChord(slot, bindings[slot], bindings).find(
    (i) => i.severity === "warning",
  );
  return w?.message ?? null;
}
