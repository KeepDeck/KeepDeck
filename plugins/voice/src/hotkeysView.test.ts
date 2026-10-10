import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, formatChord, type KeyLike } from "./binding";
import { hotkeyRows, recorderStep, resetSlot } from "./hotkeysView";

const key = (over: Partial<KeyLike>): KeyLike => ({
  code: "KeyJ",
  key: "j",
  altKey: false,
  shiftKey: false,
  ctrlKey: true,
  metaKey: true,
  repeat: false,
  ...over,
});

describe("recorderStep", () => {
  it("Escape cancels; a lone modifier waits for the main key", () => {
    expect(recorderStep("command", key({ key: "Escape", code: "Escape" }), DEFAULT_BINDINGS)).toEqual({ kind: "cancel" });
    expect(recorderStep("command", key({ key: "Meta", code: "MetaLeft" }), DEFAULT_BINDINGS)).toEqual({ kind: "wait" });
  });

  it("accepts a chord into its slot, leaving the other alone", () => {
    const step = recorderStep("command", key({}), DEFAULT_BINDINGS);
    expect(step.kind).toBe("accept");
    if (step.kind !== "accept") return;
    expect(step.bindings.command.code).toBe("KeyJ");
    expect(step.bindings.dictation).toEqual(DEFAULT_BINDINGS.dictation);
  });

  it("rejects the other slot's chord and keeps recording", () => {
    const taken = DEFAULT_BINDINGS.dictation;
    const step = recorderStep(
      "command",
      key({ code: taken.code, key: " ", altKey: taken.alt, shiftKey: taken.shift, ctrlKey: taken.ctrl, metaKey: taken.meta }),
      DEFAULT_BINDINGS,
    );
    expect(step.kind).toBe("reject");
  });
});

describe("hotkeyRows", () => {
  it("one row per slot showing its chord", () => {
    const rows = hotkeyRows(DEFAULT_BINDINGS, null, null);
    expect(rows.map((r) => [r.slot, r.chordText])).toEqual([
      ["command", formatChord(DEFAULT_BINDINGS.command)],
      ["dictation", formatChord(DEFAULT_BINDINGS.dictation)],
    ]);
  });

  it("the recording row prompts and shows its rejection; the rest stay as they are", () => {
    const rows = hotkeyRows(DEFAULT_BINDINGS, "command", "Already used for Dictation");
    expect(rows[0]).toMatchObject({
      recording: true,
      chordText: "Press keys…",
      message: { tone: "error", text: "Already used for Dictation" },
    });
    expect(rows[1].recording).toBe(false);
  });

  it("a chord without ⌥/⌃/⌘ is flagged on its row, not refused", () => {
    const bare = { ...DEFAULT_BINDINGS, command: { code: "KeyJ", alt: false, shift: false, ctrl: false, meta: false } };
    expect(hotkeyRows(bare, null, null)[0].message?.tone).toBe("warn");
  });
});

describe("resetSlot", () => {
  it("puts one slot back at its default", () => {
    const changed = { ...DEFAULT_BINDINGS, command: { code: "KeyJ", alt: false, shift: false, ctrl: true, meta: true } };
    expect(resetSlot(changed, "command")).toEqual(DEFAULT_BINDINGS);
  });
});
