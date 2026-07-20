// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPttHotkeys } from "./hotkeys";
import { DEFAULT_BINDINGS, type VoiceBindings } from "./binding";
import type { VoiceController, VoicePhase } from "./controller";

/** A controller stub that tracks phase and records start/stop/cancel — the
 * installer under real DOM wiring. start()/stop()/cancel() flip the phase
 * synchronously (their bodies have no await), matching the real controller's
 * "listening set before the first await" behavior the handler relies on. */
function fakeController(state: { phase: VoicePhase }): VoiceController {
  return {
    snapshot: () => ({ phase: state.phase, mode: null, level: 0, history: [] }),
    subscribe: () => () => {},
    start: vi.fn(async () => {
      state.phase = "listening";
    }),
    stop: vi.fn(async () => {
      state.phase = "idle";
    }),
    cancel: vi.fn(async () => {
      state.phase = "idle";
    }),
    clearHistory: () => {},
  };
}

function press(type: "keydown" | "keyup", init: KeyboardEventInit): void {
  window.dispatchEvent(
    new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
  );
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("installPttHotkeys", () => {
  it("holds the command chord to start, releases to stop", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    uninstall = installPttHotkeys(c, () => DEFAULT_BINDINGS);

    press("keydown", { code: "Space", key: " ", altKey: true });
    expect(c.start).toHaveBeenCalledWith("command");
    press("keyup", { code: "Space", key: " ", altKey: true });
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it("holds the dictation chord for dictation", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    uninstall = installPttHotkeys(c, () => DEFAULT_BINDINGS);

    press("keydown", { code: "Space", key: " ", altKey: true, shiftKey: true });
    expect(c.start).toHaveBeenCalledWith("dictation");
  });

  it("ignores keys that are not a bound chord", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    uninstall = installPttHotkeys(c, () => DEFAULT_BINDINGS);

    press("keydown", { code: "Space", key: " " }); // plain space
    press("keydown", { code: "KeyA", key: "a", altKey: true }); // ⌥A, unbound
    expect(c.start).not.toHaveBeenCalled();
  });

  it("does not restart while already listening (auto-repeat is inert)", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    uninstall = installPttHotkeys(c, () => DEFAULT_BINDINGS);

    press("keydown", { code: "Space", key: " ", altKey: true });
    press("keydown", { code: "Space", key: " ", altKey: true, repeat: true });
    expect(c.start).toHaveBeenCalledTimes(1);
  });

  it("Escape while listening cancels the hold", () => {
    const state = { phase: "listening" as VoicePhase };
    const c = fakeController(state);
    uninstall = installPttHotkeys(c, () => DEFAULT_BINDINGS);

    press("keydown", { code: "Escape", key: "Escape" });
    expect(c.cancel).toHaveBeenCalledTimes(1);
  });

  it("ends the hold from the held chord's own keys, not fixed ones", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    const bindings: VoiceBindings = {
      command: { code: "KeyJ", alt: false, shift: false, ctrl: true, meta: true },
      dictation: { code: "KeyK", alt: false, shift: false, ctrl: true, meta: true },
    };
    uninstall = installPttHotkeys(c, () => bindings);

    press("keydown", { code: "KeyJ", key: "j", ctrlKey: true, metaKey: true });
    expect(c.start).toHaveBeenCalledWith("command");
    // Releasing an unrelated modifier must not end the hold.
    press("keyup", { code: "AltLeft", key: "Alt" });
    expect(c.stop).not.toHaveBeenCalled();
    // Releasing a modifier the chord holds ends it.
    press("keyup", { code: "ControlLeft", key: "Control" });
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it("reads bindings live — a rebind takes effect with no reinstall", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    let bindings: VoiceBindings = DEFAULT_BINDINGS;
    uninstall = installPttHotkeys(c, () => bindings);

    // Rebind command to ⌃⌘J; the old ⌥Space must go dead.
    bindings = {
      command: { code: "KeyJ", alt: false, shift: false, ctrl: true, meta: true },
      dictation: DEFAULT_BINDINGS.dictation,
    };
    press("keydown", { code: "Space", key: " ", altKey: true });
    expect(c.start).not.toHaveBeenCalled();
    press("keydown", { code: "KeyJ", key: "j", ctrlKey: true, metaKey: true });
    expect(c.start).toHaveBeenCalledWith("command");
  });

  it("stands down while suspended (the settings recorder is capturing)", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    let suspended = true;
    uninstall = installPttHotkeys(c, () => DEFAULT_BINDINGS, () => suspended);

    // A bound chord pressed during recording must not start a capture.
    press("keydown", { code: "Space", key: " ", altKey: true });
    expect(c.start).not.toHaveBeenCalled();

    suspended = false;
    press("keydown", { code: "Space", key: " ", altKey: true });
    expect(c.start).toHaveBeenCalledWith("command");
  });

  it("stops listening after uninstall", () => {
    const state = { phase: "idle" as VoicePhase };
    const c = fakeController(state);
    const off = installPttHotkeys(c, () => DEFAULT_BINDINGS);
    off();

    press("keydown", { code: "Space", key: " ", altKey: true });
    expect(c.start).not.toHaveBeenCalled();
  });
});
