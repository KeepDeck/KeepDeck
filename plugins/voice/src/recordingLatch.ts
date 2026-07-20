/**
 * A one-bit latch shared between the settings key recorder and the hotkey
 * handler. Both listen on `window` in the capture phase and the handler is
 * registered first, so while the user is recording a new chord, push-to-talk
 * would otherwise fire on the very keys they press (e.g. re-pressing the
 * current chord). The recorder raises the latch while recording; the handler
 * checks it and stands down.
 */
export interface RecordingLatch {
  active(): boolean;
  begin(): void;
  end(): void;
}

export function createRecordingLatch(): RecordingLatch {
  let recording = false;
  return {
    active: () => recording,
    begin: () => {
      recording = true;
    },
    end: () => {
      recording = false;
    },
  };
}
