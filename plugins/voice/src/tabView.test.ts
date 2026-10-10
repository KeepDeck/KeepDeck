import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";
import {
  canClear,
  emptyHint,
  entryView,
  listenControl,
  modelsNotice,
  pillLabel,
  pillView,
  statusLine,
  tabScreen,
} from "./tabView";

const installed = (yes: boolean): VoiceModelInfo[] => [{ ...MODEL_CATALOG[3], installed: yes }];
const state = (over: Partial<Parameters<typeof tabScreen>[1]> = {}) => ({
  models: installed(true),
  error: null,
  downloading: false,
  ...over,
});

describe("words in flight", () => {
  it("dictation types — it never says it sends", () => {
    expect(pillLabel("listening", "dictation")).toBe("Dictating — release to type");
    expect(statusLine("listening", "dictation")).toBe("listening — release to type, Esc cancels");
    expect(pillLabel("listening", "command")).toBe("Listening — release to run");
  });

  it("transcribing says Escape discards; idle says nothing", () => {
    expect(statusLine("transcribing", "command")).toBe("transcribing — Esc discards");
    expect(pillLabel("idle", null)).toBeNull();
    expect(statusLine("idle", null)).toBeNull();
  });
});

describe("tabScreen", () => {
  it("prompts for a model only when idle, known to have none, and nothing downloading", () => {
    expect(tabScreen("idle", state({ models: installed(false) }))).toBe("setup");
    expect(tabScreen("idle", state())).toBe("main");
    expect(tabScreen("idle", state({ models: null }))).toBe("main");
    expect(tabScreen("idle", state({ models: installed(false), downloading: true }))).toBe("main");
  });

  it("never swaps a hold or a transcription for the prompt — Stop and the history stay", () => {
    expect(tabScreen("listening", state({ models: installed(false) }))).toBe("main");
    expect(tabScreen("transcribing", state({ models: installed(false) }))).toBe("main");
  });
});

describe("modelsNotice and listenControl", () => {
  it("an unreadable model list is said, and listening is off until it is read", () => {
    const broken = state({ models: null, error: "engines unavailable" });
    expect(modelsNotice(broken)).toEqual({ text: "Couldn't read the speech models: engines unavailable" });
    expect(listenControl("idle", "⌘⇧Space", broken).disabled).toBe(true);
    expect(modelsNotice(state())).toBeNull();
  });

  it("Listen / Stop, off while transcribing", () => {
    expect(listenControl("idle", "⌘⇧Space", state())).toEqual({
      label: "🎙 Listen",
      title: "Toggle command listening (or hold ⌘⇧Space)",
      on: false,
      disabled: false,
    });
    expect(listenControl("listening", "⌘⇧Space", state()).label).toBe("◼ Stop");
    expect(listenControl("transcribing", "⌘⇧Space", state()).disabled).toBe(true);
  });

  it("a hold in progress can always be stopped, even if the list broke meanwhile", () => {
    expect(listenControl("listening", "⌘⇧Space", state({ error: "x" })).disabled).toBe(false);
  });
});

describe("entryView", () => {
  const entry = { at: 1, tone: "heard" as const, text: "привет" };
  it("shows the text, or the copy flash in its place", () => {
    expect(entryView(entry, null)).toEqual({ variant: null, text: "привет", title: "Click to copy", glyph: "🗣" });
    expect(entryView(entry, { ok: true })).toMatchObject({ variant: "copied", text: "Copied" });
    expect(entryView(entry, { ok: false })).toMatchObject({ variant: "failed", text: "Copy failed" });
  });
});

describe("tab chrome decisions", () => {
  it("Clear is offered only for an existing history while idle", () => {
    expect(canClear("idle", 2)).toBe(true);
    expect(canClear("idle", 0)).toBe(false);
    expect(canClear("listening", 2)).toBe(false);
  });

  it("the empty hint names both live chords", () => {
    const parts = emptyHint("⌥Space", "⌥⇧Space");
    expect(parts.filter((p) => "chord" in p)).toEqual([{ chord: "⌥Space" }, { chord: "⌥⇧Space" }]);
    expect(parts.some((p) => "info" in p)).toBe(true);
  });

  it("the pill hides when idle; its live dot only while listening", () => {
    expect(pillView("idle", null).visible).toBe(false);
    expect(pillView("listening", "command")).toMatchObject({ visible: true, live: true });
    expect(pillView("transcribing", "command")).toMatchObject({ visible: true, live: false });
  });
});
