import type { VoiceMode } from "./controller";

/**
 * Push-to-talk key bindings — the user-editable chords behind command and
 * dictation. The hotkey handler, the settings recorder, and the help copy all
 * read one shape from here; nothing hardcodes ⌥Space any more.
 *
 * These are IN-APP hotkeys (capture-phase key events, not global shortcuts).
 * Because the handler preventDefaults a matched chord, a binding without a
 * ⌥/⌃/⌘ modifier can swallow that key from the terminal — allowed, but flagged
 * (see {@link validateChord}).
 */

/** A single chord: one main key (KeyboardEvent.code) plus the modifier state
 * that must match EXACTLY. Exact matching means two distinct chords can never
 * both fire for one keystroke, so command and dictation need no precedence. */
export interface Chord {
  /** KeyboardEvent.code of the main key, e.g. "Space", "KeyJ". */
  code: string;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}

export interface VoiceBindings {
  command: Chord;
  dictation: Chord;
}

/** The shipped defaults: ⌥Space speaks a command, ⌥⇧Space dictates. */
export const DEFAULT_BINDINGS: VoiceBindings = {
  command: { code: "Space", alt: true, shift: false, ctrl: false, meta: false },
  dictation: { code: "Space", alt: true, shift: true, ctrl: false, meta: false },
};

/** Settings key the bindings persist under, in the plugin's values bag. */
export const HOTKEYS_KEY = "hotkeys";

/** The shape a KeyboardEvent presents to the pure matchers — a plain subset so
 * the golden tests can build one without a real event. */
export interface KeyLike {
  code: string;
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** A modifier by KeyboardEvent.key — recording skips these (a chord needs a
 * main key) and a keyup on one only ends a hold whose chord holds it down. */
export function isModifierKey(key: string): boolean {
  return key === "Alt" || key === "Shift" || key === "Control" || key === "Meta";
}

/** True when the event's key state matches the chord exactly. */
export function matchChord(e: KeyLike, chord: Chord): boolean {
  return (
    e.code === chord.code &&
    e.altKey === chord.alt &&
    e.shiftKey === chord.shift &&
    e.ctrlKey === chord.ctrl &&
    e.metaKey === chord.meta
  );
}

/** Which PTT mode a keydown starts, if any. Exact matching → at most one mode
 * ever matches, so the check order is immaterial. */
export function pttMode(e: KeyLike, bindings: VoiceBindings): VoiceMode | null {
  if (matchChord(e, bindings.dictation)) return "dictation";
  if (matchChord(e, bindings.command)) return "command";
  return null;
}

/** Whether a keyup releases the active hold: the chord's main key, or any
 * modifier the chord holds down. Derived from the chord that STARTED the hold,
 * so a custom binding stops on exactly the keys it uses. */
export function endsHold(e: KeyLike, chord: Chord): boolean {
  if (e.code === chord.code) return true;
  if (!isModifierKey(e.key)) return false;
  return (
    (e.key === "Alt" && chord.alt) ||
    (e.key === "Shift" && chord.shift) ||
    (e.key === "Control" && chord.ctrl) ||
    (e.key === "Meta" && chord.meta)
  );
}

/** Capture a chord from a recorded keydown. */
export function chordFromEvent(e: KeyLike): Chord {
  return {
    code: e.code,
    alt: e.altKey,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
  };
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return (
    a.code === b.code &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.ctrl === b.ctrl &&
    a.meta === b.meta
  );
}

/** Read the bindings from the plugin's settings values, defaulting any missing
 * or malformed part — settings.json is hand-editable, so its shape is never
 * trusted. A garbage chord falls back to that slot's shipped default. */
export function parseBindings(values: Record<string, unknown>): VoiceBindings {
  const raw = values[HOTKEYS_KEY];
  if (!raw || typeof raw !== "object") return DEFAULT_BINDINGS;
  const bag = raw as Record<string, unknown>;
  return {
    command: parseChord(bag.command, DEFAULT_BINDINGS.command),
    dictation: parseChord(bag.dictation, DEFAULT_BINDINGS.dictation),
  };
}

function parseChord(raw: unknown, fallback: Chord): Chord {
  if (!raw || typeof raw !== "object") return fallback;
  const c = raw as Record<string, unknown>;
  if (typeof c.code !== "string" || c.code === "") return fallback;
  return {
    code: c.code,
    alt: c.alt === true,
    shift: c.shift === true,
    ctrl: c.ctrl === true,
    meta: c.meta === true,
  };
}

export interface BindingIssue {
  severity: "error" | "warning";
  message: string;
}

/**
 * Validate a proposed chord for one slot against the current bindings. Errors
 * BLOCK the write (a broken binding); warnings inform but allow it — the user
 * asked to bind any chord. Only two hard rules, both correctness, not policy:
 *   - Escape is reserved for cancelling a recording/hold, so it can't be bound;
 *   - the two slots must differ, or one keystroke means both.
 */
export function validateChord(
  slot: keyof VoiceBindings,
  chord: Chord,
  bindings: VoiceBindings,
): BindingIssue[] {
  const issues: BindingIssue[] = [];
  const other = slot === "command" ? bindings.dictation : bindings.command;
  if (chord.code === "Escape") {
    issues.push({
      severity: "error",
      message: "Escape is reserved for cancelling — pick another key.",
    });
  }
  if (chordsEqual(chord, other)) {
    issues.push({
      severity: "error",
      message: "Command and dictation must use different chords.",
    });
  }
  if (!chord.alt && !chord.ctrl && !chord.meta) {
    issues.push({
      severity: "warning",
      message: "No ⌥/⌃/⌘ modifier — this may shadow typing in the terminal.",
    });
  }
  return issues;
}

/** A readable chord label in mac glyph order (⌃⌥⇧⌘): ⌥⇧Space, ⌃⌘J. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("⌃");
  if (chord.alt) parts.push("⌥");
  if (chord.shift) parts.push("⇧");
  if (chord.meta) parts.push("⌘");
  parts.push(keyLabel(chord.code));
  return parts.join("");
}

/** A short human label for a KeyboardEvent.code. */
function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3); // KeyJ → J
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 → 1
  if (code.startsWith("Arrow")) return code.slice(5); // ArrowUp → Up
  return code; // Space, Enter, Tab, F5, … read fine as-is
}
