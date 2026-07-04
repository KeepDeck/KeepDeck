import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SETTINGS_VERSION,
  clampScrollback,
  defaultSettingsDocument,
  hydrateSettings,
  serializeSettings,
} from "./settings";

describe("hydrateSettings", () => {
  it("an empty object yields pure defaults", () => {
    expect(hydrateSettings("{}")).toEqual({
      settings: DEFAULT_SETTINGS,
      extras: {},
    });
  });

  it("rejects only what isn't a JSON object — the quarantine cases", () => {
    expect(hydrateSettings("{corrupt")).toBeNull();
    expect(hydrateSettings("null")).toBeNull();
    expect(hydrateSettings('"a string"')).toBeNull();
    expect(hydrateSettings("[1,2]")).toBeNull();
  });

  it("reads every recognized key", () => {
    const doc = hydrateSettings(
      JSON.stringify({
        version: 1,
        defaultAgent: "codex",
        scrollback: 50_000,
        confirmBeforeClose: false,
      }),
    );
    expect(doc?.settings).toEqual({
      defaultAgent: "codex",
      scrollback: 50_000,
      confirmBeforeClose: false,
    });
  });

  it("a malformed value degrades ONLY its own key", () => {
    // The file is hand-editable: one typo must not reset the other settings.
    const doc = hydrateSettings(
      JSON.stringify({
        defaultAgent: "vim", // not an agent
        scrollback: 50_000, // fine
        confirmBeforeClose: "yes", // not a boolean
      }),
    );
    expect(doc?.settings).toEqual({ ...DEFAULT_SETTINGS, scrollback: 50_000 });
  });

  it("clamps scrollback into bounds and whole lines", () => {
    const at = (scrollback: unknown) =>
      hydrateSettings(JSON.stringify({ scrollback }))?.settings.scrollback;
    expect(at(5)).toBe(SCROLLBACK_MIN);
    expect(at(1e9)).toBe(SCROLLBACK_MAX);
    expect(at(2000.7)).toBe(2001);
    // Not even a finite number → the default, not a clamp of garbage.
    expect(at("many")).toBe(DEFAULT_SETTINGS.scrollback);
    expect(at(Number.NaN)).toBe(DEFAULT_SETTINGS.scrollback);
  });

  it("null defaultAgent is a valid explicit 'automatic'", () => {
    const doc = hydrateSettings(JSON.stringify({ defaultAgent: null }));
    expect(doc?.settings.defaultAgent).toBeNull();
  });
});

describe("serializeSettings", () => {
  it("pure defaults write only the version — sparse by design", () => {
    expect(serializeSettings(defaultSettingsDocument())).toBe(
      JSON.stringify({ version: SETTINGS_VERSION }),
    );
  });

  it("writes only the keys that differ from their defaults", () => {
    const doc = defaultSettingsDocument();
    doc.settings.confirmBeforeClose = false;
    const out = JSON.parse(serializeSettings(doc));
    expect(out).toEqual({ version: SETTINGS_VERSION, confirmBeforeClose: false });
  });

  it("preserves unknown keys across a hydrate→serialize round-trip", () => {
    // Hand edits and keys written by a newer build must survive our saves.
    const stored = JSON.stringify({
      version: 1,
      scrollback: 20_000,
      futureToggle: { nested: true },
    });
    const doc = hydrateSettings(stored)!;
    const out = JSON.parse(serializeSettings(doc));
    expect(out.futureToggle).toEqual({ nested: true });
    expect(out.scrollback).toBe(20_000);
  });

  it("round-trips a changed document losslessly", () => {
    const doc = defaultSettingsDocument();
    doc.settings.defaultAgent = "opencode";
    doc.settings.scrollback = 42_000;
    expect(hydrateSettings(serializeSettings(doc))).toEqual(doc);
  });
});

describe("clampScrollback", () => {
  it("keeps in-range values untouched", () => {
    expect(clampScrollback(10_000)).toBe(10_000);
  });
});
