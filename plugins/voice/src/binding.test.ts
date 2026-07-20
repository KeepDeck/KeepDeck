import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  chordsEqual,
  DEFAULT_BINDINGS,
  endsHold,
  formatChord,
  HOTKEYS_KEY,
  isModifierKey,
  matchChord,
  parseBindings,
  pttMode,
  validateChord,
  type Chord,
  type KeyLike,
  type VoiceBindings,
} from "./binding";

const key = (over: Partial<KeyLike>): KeyLike => ({
  code: "Space",
  key: " ",
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  ...over,
});

const chord = (over: Partial<Chord>): Chord => ({
  code: "Space",
  alt: false,
  shift: false,
  ctrl: false,
  meta: false,
  ...over,
});

describe("pttMode (default bindings)", () => {
  it("⌥Space is command, ⌥⇧Space is dictation", () => {
    expect(pttMode(key({ altKey: true }), DEFAULT_BINDINGS)).toBe("command");
    expect(pttMode(key({ altKey: true, shiftKey: true }), DEFAULT_BINDINGS)).toBe(
      "dictation",
    );
  });

  it("anything else is not a PTT chord", () => {
    expect(pttMode(key({}), DEFAULT_BINDINGS)).toBeNull(); // plain space types a space
    expect(pttMode(key({ altKey: true, ctrlKey: true }), DEFAULT_BINDINGS)).toBeNull();
    expect(pttMode(key({ altKey: true, metaKey: true }), DEFAULT_BINDINGS)).toBeNull();
    expect(pttMode(key({ altKey: true, code: "KeyV" }), DEFAULT_BINDINGS)).toBeNull();
  });
});

describe("pttMode (custom bindings)", () => {
  const bindings: VoiceBindings = {
    command: chord({ code: "KeyJ", ctrl: true, meta: true }),
    dictation: chord({ code: "KeyK", ctrl: true, meta: true }),
  };

  it("matches the configured chords, exactly on every modifier", () => {
    expect(
      pttMode(key({ code: "KeyJ", key: "j", ctrlKey: true, metaKey: true }), bindings),
    ).toBe("command");
    expect(
      pttMode(key({ code: "KeyK", key: "k", ctrlKey: true, metaKey: true }), bindings),
    ).toBe("dictation");
    // An extra modifier is a different chord, so it must not match.
    expect(
      pttMode(
        key({ code: "KeyJ", key: "j", ctrlKey: true, metaKey: true, shiftKey: true }),
        bindings,
      ),
    ).toBeNull();
    // The old ⌥Space no longer does anything once rebound.
    expect(pttMode(key({ altKey: true }), bindings)).toBeNull();
  });
});

describe("matchChord", () => {
  it("requires an exact match on code and all four modifiers", () => {
    const c = chord({ code: "KeyG", alt: true });
    expect(matchChord(key({ code: "KeyG", altKey: true }), c)).toBe(true);
    expect(matchChord(key({ code: "KeyG" }), c)).toBe(false); // missing alt
    expect(matchChord(key({ code: "KeyG", altKey: true, shiftKey: true }), c)).toBe(
      false,
    ); // extra shift
  });
});

describe("endsHold (derived from the held chord)", () => {
  it("default ⌥Space ends on Space or Alt, not Shift", () => {
    const c = DEFAULT_BINDINGS.command;
    expect(endsHold(key({ code: "Space" }), c)).toBe(true);
    expect(endsHold(key({ code: "AltLeft", key: "Alt" }), c)).toBe(true);
    expect(endsHold(key({ code: "ShiftLeft", key: "Shift" }), c)).toBe(false);
  });

  it("a ⌃⌘ chord ends on its main key or either held modifier, nothing else", () => {
    const c = chord({ code: "KeyJ", ctrl: true, meta: true });
    expect(endsHold(key({ code: "KeyJ", key: "j" }), c)).toBe(true);
    expect(endsHold(key({ code: "ControlLeft", key: "Control" }), c)).toBe(true);
    expect(endsHold(key({ code: "MetaLeft", key: "Meta" }), c)).toBe(true);
    // Alt is not part of this chord, so releasing it must not end the hold.
    expect(endsHold(key({ code: "AltLeft", key: "Alt" }), c)).toBe(false);
    // An unrelated key never ends it.
    expect(endsHold(key({ code: "KeyA", key: "a" }), c)).toBe(false);
  });
});

describe("parseBindings", () => {
  it("returns defaults when unset or the wrong type", () => {
    expect(parseBindings({})).toEqual(DEFAULT_BINDINGS);
    expect(parseBindings({ [HOTKEYS_KEY]: "nope" })).toEqual(DEFAULT_BINDINGS);
    expect(parseBindings({ [HOTKEYS_KEY]: 42 })).toEqual(DEFAULT_BINDINGS);
  });

  it("round-trips a stored chord and coerces missing modifier flags to false", () => {
    const stored = {
      [HOTKEYS_KEY]: {
        command: { code: "KeyG", ctrl: true },
        dictation: { code: "KeyH", ctrl: true, shift: true },
      },
    };
    expect(parseBindings(stored)).toEqual({
      command: chord({ code: "KeyG", ctrl: true }),
      dictation: chord({ code: "KeyH", ctrl: true, shift: true }),
    });
  });

  it("defaults only the malformed slot, keeping the valid one", () => {
    const stored = {
      [HOTKEYS_KEY]: { command: { code: 123 }, dictation: { code: "KeyH", meta: true } },
    };
    expect(parseBindings(stored)).toEqual({
      command: DEFAULT_BINDINGS.command,
      dictation: chord({ code: "KeyH", meta: true }),
    });
  });

  it("loads a hand-edited duplicate as-is (structure only), leaving command dead", () => {
    // parseBindings does NOT re-enforce validateChord's distinctness rule; a
    // structurally-valid but duplicate pair loads verbatim, and pttMode then
    // deterministically resolves the shared keystroke to dictation.
    const dup = chord({ code: "KeyD", ctrl: true, meta: true });
    const parsed = parseBindings({ [HOTKEYS_KEY]: { command: dup, dictation: dup } });
    expect(parsed).toEqual({ command: dup, dictation: dup });
    expect(
      pttMode(key({ code: "KeyD", key: "d", ctrlKey: true, metaKey: true }), parsed),
    ).toBe("dictation");
  });
});

describe("chordFromEvent / chordsEqual", () => {
  it("captures the modifier state of the keydown", () => {
    expect(
      chordFromEvent(key({ code: "KeyP", key: "p", altKey: true, metaKey: true })),
    ).toEqual(chord({ code: "KeyP", alt: true, meta: true }));
  });

  it("compares chords structurally", () => {
    expect(chordsEqual(DEFAULT_BINDINGS.command, chord({ code: "Space", alt: true }))).toBe(
      true,
    );
    expect(chordsEqual(DEFAULT_BINDINGS.command, DEFAULT_BINDINGS.dictation)).toBe(false);
  });
});

describe("validateChord", () => {
  it("blocks Escape as a reserved key", () => {
    const issues = validateChord("command", chord({ code: "Escape" }), DEFAULT_BINDINGS);
    expect(issues.some((i) => i.severity === "error" && /Escape/.test(i.message))).toBe(
      true,
    );
  });

  it("blocks a chord identical to the other slot", () => {
    // Propose the dictation chord for the command slot.
    const issues = validateChord("command", DEFAULT_BINDINGS.dictation, DEFAULT_BINDINGS);
    expect(
      issues.some((i) => i.severity === "error" && /different/.test(i.message)),
    ).toBe(true);
  });

  it("warns, but does not block, a chord with no ⌥/⌃/⌘ modifier", () => {
    const issues = validateChord("command", chord({ code: "KeyB" }), DEFAULT_BINDINGS);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(issues.some((i) => /shadow/.test(i.message))).toBe(true);
  });

  it("shift-only still counts as no real modifier (warns)", () => {
    const issues = validateChord("command", chord({ code: "KeyB", shift: true }), DEFAULT_BINDINGS);
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("accepts a distinct, modified chord with no issues", () => {
    expect(
      validateChord("command", chord({ code: "KeyG", ctrl: true }), DEFAULT_BINDINGS),
    ).toEqual([]);
  });
});

describe("formatChord / isModifierKey", () => {
  it("renders mac glyphs in ⌃⌥⇧⌘ order with a short key label", () => {
    expect(formatChord(DEFAULT_BINDINGS.command)).toBe("⌥Space");
    expect(formatChord(DEFAULT_BINDINGS.dictation)).toBe("⌥⇧Space");
    expect(formatChord(chord({ code: "KeyJ", ctrl: true, meta: true }))).toBe("⌃⌘J");
    expect(formatChord(chord({ code: "Digit1", alt: true }))).toBe("⌥1");
  });

  it("recognizes the four modifier keys", () => {
    for (const k of ["Alt", "Shift", "Control", "Meta"]) {
      expect(isModifierKey(k)).toBe(true);
    }
    expect(isModifierKey("a")).toBe(false);
  });
});
