import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  clampScrollback,
  defaultSettingsDocument,
  serializeSettings,
  withPluginMuted,
  withSettings,
  type Settings,
} from ".";
import { restore } from "./settings.testSupport";

/** How a chosen value enters a document, and the two value helpers. */

describe("withSettings", () => {
  it("records the patched key as chosen and resolves the value", () => {
    const doc = withSettings(defaultSettingsDocument(), { dockMode: "floating" });
    expect(doc.chosen).toEqual({ dockMode: "floating" });
    expect(doc.settings.dockMode).toBe("floating");
    // Everything else still resolves to its default, and stays unchosen.
    expect(doc.settings.deckLayout).toBe(DEFAULT_SETTINGS.deckLayout);
    expect(serializeSettings(doc)).not.toContain("deckLayout");
  });

  it("records a value that equals the default — choosing it IS a decision", () => {
    const doc = withSettings(defaultSettingsDocument(), { mcpServer: false });
    expect(doc.chosen).toEqual({ mcpServer: false });
    expect(JSON.parse(serializeSettings(doc)).mcpServer).toBe(false);
  });

  it("accumulates decisions and never mutates its input", () => {
    const base = defaultSettingsDocument();
    const once = withSettings(base, { defaultYolo: true });
    const twice = withSettings(once, { dockMode: "floating" });
    expect(twice.chosen).toEqual({ defaultYolo: true, dockMode: "floating" });
    expect(once.chosen).toEqual({ defaultYolo: true });
    expect(base.chosen).toEqual({});
  });

  it("keeps the stored file's unknown keys across a change", () => {
    const stored = restore('{"futureToggle":true}');
    expect(withSettings(stored, { defaultYolo: true }).extras).toMatchObject({
      futureToggle: true,
    });
  });

  it("drops an explicit undefined instead of recording an erased decision", () => {
    // `Partial<Settings>` admits `{mcpServer: undefined}`, and JSON.stringify
    // then omits the key — so recording it would mark a setting chosen and
    // erased at the same time.
    const doc = withSettings(defaultSettingsDocument(), {
      mcpServer: undefined,
      dockMode: "floating",
    });
    expect(doc.chosen).toEqual({ dockMode: "floating" });
    expect(doc.settings.mcpServer).toBe(false);
  });

  it("drops a key the settings table does not know", () => {
    const doc = withSettings(defaultSettingsDocument(), {
      bogus: 1,
    } as unknown as Partial<Settings>);
    expect(doc.chosen).toEqual({});
    expect(serializeSettings(doc)).not.toContain("bogus");
  });

  it("the resolved settings always equal the defaults overlaid with the decisions", () => {
    const doc = withSettings(restore('{"scrollback":20000}'), { dockMode: "floating" });
    expect(doc.settings).toEqual({ ...DEFAULT_SETTINGS, ...doc.chosen });
  });
});

describe("clampScrollback", () => {
  it("keeps in-range values and pulls the rest to the nearest bound", () => {
    expect(clampScrollback(10_000)).toBe(10_000);
    expect(clampScrollback(5)).toBe(SCROLLBACK_MIN);
    expect(clampScrollback(1e9)).toBe(SCROLLBACK_MAX);
    expect(clampScrollback(2000.7)).toBe(2001);
  });
});

describe("withPluginMuted", () => {
  it("adds once, removes cleanly, and never mutates the input", () => {
    const prefs = {
      enabled: true,
      mode: "system-and-app" as const,
      mutedPlugins: ["a"],
    };
    const muted = withPluginMuted(withPluginMuted(prefs, "b", true), "b", true);
    expect(muted.mutedPlugins).toEqual(["a", "b"]); // dedup: no stacking
    expect(withPluginMuted(muted, "b", false).mutedPlugins).toEqual(["a"]);
    expect(withPluginMuted(prefs, "a", false).mutedPlugins).toEqual([]);
    expect(prefs.mutedPlugins).toEqual(["a"]); // input untouched
  });
});
