import { useEffect, useState, useSyncExternalStore } from "react";
import type { CustomSettingsFieldProps } from "@keepdeck/plugin-api";
import { Button } from "@keepdeck/ui-kit/Button";
import { HOTKEYS_KEY, type VoiceBindings } from "../binding";
import { HOTKEYS_TEXT, hotkeyRows, recorderStep, resetSlot } from "../hotkeysView";
import { runtime } from "../runtime";

/**
 * The push-to-talk hotkey editor, rendered inside the plugin's settings page (a
 * `custom` field — the declarative vocabulary has no key recorder). Two rows,
 * Command and Dictation: click a shortcut, press a combination, and it's
 * captured and validated. Any chord is allowed; one with no ⌥/⌃/⌘ modifier is
 * kept but flagged, since the in-app handler swallows it from the terminal.
 * Escape is reserved for cancelling and can't be bound.
 *
 * Display reads the shared bindings STORE — not the `values` prop that sibling
 * fields like ModelsSection read — because the PTT handler reads that same
 * store and both must show one truth, and the store always holds a complete
 * pair for `withSlot` to write back. A pick still persists through the host
 * `write`, which round-trips back to the store, so the row updates on its own.
 */
export function HotkeysSection({ write }: CustomSettingsFieldProps) {
  const { bindings: store } = runtime();
  const bindings = useSyncExternalStore(store.subscribe, store.snapshot);
  // Which row is capturing, if any — only one at a time; the rejection is the
  // last refused attempt for that row.
  const [recording, setRecording] = useState<keyof VoiceBindings | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    // Silence push-to-talk for the duration, so the keys we're capturing don't
    // also fire a command or dictation.
    const { recordingLatch } = runtime();
    recordingLatch.begin();
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const step = recorderStep(recording, e, bindings);
      switch (step.kind) {
        case "cancel":
          return setRecording(null);
        case "wait":
          return;
        case "reject":
          return setRejection(step.message);
        case "accept":
          write(HOTKEYS_KEY, step.bindings);
          setRejection(null);
          return setRecording(null);
      }
    };
    // A pointer press outside the editor abandons the recording. The settings
    // dialog keeps every section mounted and merely hides inactive ones, so
    // navigating away mid-recording would otherwise leave PTT globally
    // suspended and the next keystroke hijacked.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Element | null;
      if (!target?.closest(".voice-hotkeys")) setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      recordingLatch.end();
    };
  }, [recording, bindings, write]);

  return (
    <div className="voice-hotkeys">
      <div className="voice-hotkeys__intro">{HOTKEYS_TEXT.intro}</div>
      {hotkeyRows(bindings, recording, rejection).map((row) => (
        <div key={row.slot} className="voice-hotkeys__row">
          <div className="voice-hotkeys__labels">
            <span className="voice-hotkeys__label">{row.label}</span>
            <span className="voice-hotkeys__hint">{row.hint}</span>
          </div>
          <div className="voice-hotkeys__controls">
            <Button
              size="sm"
              variant={row.recording ? "primary" : "secondary"}
              className="voice-hotkeys__chord"
              label={row.ariaLabel}
              onClick={() => {
                setRejection(null);
                setRecording(row.recording ? null : row.slot);
              }}
            >
              {row.chordText}
            </Button>
            <Button
              size="sm"
              className="voice-hotkeys__reset"
              onClick={() => {
                setRejection(null);
                setRecording(null);
                write(HOTKEYS_KEY, resetSlot(bindings, row.slot));
              }}
              title={HOTKEYS_TEXT.resetTitle}
            >
              {HOTKEYS_TEXT.reset}
            </Button>
          </div>
          {row.message && (
            <div className={row.message.tone === "error" ? "voice-hotkeys__error" : "voice-hotkeys__warn"}>
              {row.message.text}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
