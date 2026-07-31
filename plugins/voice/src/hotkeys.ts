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
  isSuspended: () => boolean = () => false,
): () => void {
  // Only a hold the KEY started may be stopped by a keyup — the mic button's
  // toggle session must survive stray key releases. The chord that started the
  // hold decides which releases end it, even if settings change mid-hold.
  let heldChord: Chord | null = null;

  const onKeyDown = (e: KeyboardEvent): void => {
    // The settings recorder is capturing a new chord — don't START a hold on
    // its keys. A keyup is NOT gated (see onKeyUp): a hold already in progress
    // must still be releasable, or its mic capture is stranded open.
    if (isSuspended()) return;
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
    // Deliberately NOT gated by isSuspended: if a hold was active when the
    // recorder started, its release must still end the capture. With no hold
    // (heldChord null) this is a no-op, so recorder keys pass through harmless.
    if (!heldChord || !endsHold(e, heldChord)) return;
    e.preventDefault();
    e.stopPropagation();
    heldChord = null;
    void controller.stop();
  };

  // A hold ends on keyup — but Cmd-Tab, Spotlight and the screen lock eat
  // the keyup, leaving `heldChord` set and the microphone recording in the
  // background. Losing the window mid-hold CANCELS (the dragManager rule for
  // this class of loss): the utterance is truncated at an arbitrary point,
  // and transcribing half a command could execute something the user never
  // said. A toggle session (`heldChord` null) is deliberately untouched —
  // it was started by a click, not a key the window just lost.
  const onWindowLost = (): void => {
    if (!heldChord) return;
    heldChord = null;
    void controller.cancel();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") onWindowLost();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onWindowLost);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onWindowLost);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
