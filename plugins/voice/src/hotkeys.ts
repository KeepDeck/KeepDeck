import type { VoiceController, VoiceMode } from "./controller";

/**
 * Push-to-talk hotkeys, in-app for the MVP (global shortcuts arrive later):
 * hold ⌥Space to speak a COMMAND, ⌥⇧Space to DICTATE into the focused pane;
 * releasing either key stops and transcribes; Escape while holding cancels.
 * Handlers run in the CAPTURE phase with preventDefault so the terminal
 * never sees the chord (the Shift+Enter keymap precedent).
 */
export interface KeyLike {
  code: string;
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** Which PTT mode a keydown starts, if any. Pure — the golden tests pin the
 * chords. */
export function pttMode(e: KeyLike): VoiceMode | null {
  if (e.code !== "Space" || !e.altKey || e.ctrlKey || e.metaKey) return null;
  return e.shiftKey ? "dictation" : "command";
}

/** Whether a keyup ends the hold: the space itself or either modifier. */
export function endsHold(e: KeyLike): boolean {
  return e.code === "Space" || e.key === "Alt" || e.key === "Shift";
}

export function installPttHotkeys(controller: VoiceController): () => void {
  // Only a hold the KEY started may be stopped by a keyup — the mic button's
  // toggle session must survive stray key releases.
  let heldByKey = false;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && controller.snapshot().phase === "listening") {
      e.preventDefault();
      e.stopPropagation();
      heldByKey = false;
      void controller.cancel();
      return;
    }
    const mode = pttMode(e);
    if (!mode) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || controller.snapshot().phase !== "idle") return;
    heldByKey = true;
    void controller.start(mode);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (!heldByKey || !endsHold(e)) return;
    e.preventDefault();
    e.stopPropagation();
    heldByKey = false;
    void controller.stop();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
  };
}
