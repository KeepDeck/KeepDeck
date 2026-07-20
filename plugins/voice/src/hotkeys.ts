import type { VoiceController } from "./controller";
import { endsHold, pttMode, type Chord, type VoiceBindings } from "./binding";

/**
 * Push-to-talk hotkeys, in-app for now (global shortcuts arrive later). The
 * chords are user-configurable (see binding.ts): the handler reads the LIVE
 * bindings through a getter, so an edit in settings takes effect at once with
 * no reinstall. Hold the command chord to speak a COMMAND, the dictation chord
 * to DICTATE into the focused pane; releasing a held key of that chord stops
 * and transcribes; Escape while holding cancels. Handlers run in the CAPTURE
 * phase with preventDefault so the terminal never sees the chord (the
 * Shift+Enter keymap precedent).
 */
export function installPttHotkeys(
  controller: VoiceController,
  getBindings: () => VoiceBindings,
): () => void {
  // Only a hold the KEY started may be stopped by a keyup — the mic button's
  // toggle session must survive stray key releases. The chord that started the
  // hold decides which releases end it, even if settings change mid-hold.
  let heldChord: Chord | null = null;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && controller.snapshot().phase === "listening") {
      e.preventDefault();
      e.stopPropagation();
      heldChord = null;
      void controller.cancel();
      return;
    }
    const bindings = getBindings();
    const mode = pttMode(e, bindings);
    if (!mode) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || controller.snapshot().phase !== "idle") return;
    heldChord = bindings[mode];
    void controller.start(mode);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (!heldChord || !endsHold(e, heldChord)) return;
    e.preventDefault();
    e.stopPropagation();
    heldChord = null;
    void controller.stop();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
  };
}
