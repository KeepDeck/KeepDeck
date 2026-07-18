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
  withPluginMuted,
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
        defaultYolo: true,
        scrollback: 50_000,
        deckLayout: "list",
        minimizeStyle: "strip",
        plugins: {
          enabled: { git: true },
          values: { git: { remote: "origin" } },
        },
        notifications: { enabled: false, mode: "system" },
        usageDisplay: "left",
      }),
    );
    expect(doc?.settings).toEqual({
      defaultAgent: "codex",
      defaultYolo: true,
      scrollback: 50_000,
      deckLayout: "list",
      minimizeStyle: "strip",
      plugins: { enabled: { git: true }, values: { git: { remote: "origin" } }, consented: {} },
      notifications: { enabled: false, mode: "system", mutedPlugins: [] },
      usageDisplay: "left",
    });
  });

  it("snaps a malformed usageDisplay back to the default", () => {
    expect(hydrateSettings('{"usageDisplay":"sideways"}')?.settings.usageDisplay).toBe(
      "used",
    );
  });

  it("serializes usageDisplay only when it left the default", () => {
    const doc = hydrateSettings('{"usageDisplay":"left"}')!;
    expect(JSON.parse(serializeSettings(doc)).usageDisplay).toBe("left");
    const untouched = hydrateSettings("{}")!;
    expect(JSON.parse(serializeSettings(untouched))).not.toHaveProperty(
      "usageDisplay",
    );
  });

  it("defaults deckLayout to grid and minimizeStyle to tray when absent", () => {
    const s = hydrateSettings("{}")?.settings;
    expect(s?.deckLayout).toBe("grid");
    expect(s?.minimizeStyle).toBe("tray");
  });

  it("accepts each known deckLayout and rejects an unknown one", () => {
    for (const layout of ["grid", "list"]) {
      expect(hydrateSettings(JSON.stringify({ deckLayout: layout }))?.settings.deckLayout).toBe(
        layout,
      );
    }
    expect(hydrateSettings(JSON.stringify({ deckLayout: "spiral" }))?.settings.deckLayout).toBe(
      "grid",
    );
  });

  it("accepts each known minimizeStyle and rejects an unknown one", () => {
    for (const style of ["tray", "strip", "none"]) {
      expect(hydrateSettings(JSON.stringify({ minimizeStyle: style }))?.settings.minimizeStyle).toBe(
        style,
      );
    }
    // A garbage value degrades to the default, on its own, like any other key.
    // (`list` moved to deckLayout — it's no longer a minimize style.)
    for (const bad of ["list", "mosaic", 3]) {
      expect(
        hydrateSettings(JSON.stringify({ minimizeStyle: bad }))?.settings.minimizeStyle,
      ).toBe("tray");
    }
  });

  it("serializes deckLayout / minimizeStyle only when they differ from default (sparse)", () => {
    const base = defaultSettingsDocument();
    expect(serializeSettings(base)).not.toContain("deckLayout");
    expect(serializeSettings(base)).not.toContain("minimizeStyle");
    const changed = {
      ...base,
      settings: { ...base.settings, deckLayout: "list" as const, minimizeStyle: "strip" as const },
    };
    const out = JSON.parse(serializeSettings(changed));
    expect(out.deckLayout).toBe("list");
    expect(out.minimizeStyle).toBe("strip");
  });

  it("v5 graduation: an explicit experimentRunPresets=false disables the Run plugin", () => {
    const doc = hydrateSettings(JSON.stringify({ experimentRunPresets: false }));
    expect(doc?.settings.plugins.enabled["keepdeck.run"]).toBe(false);
    // Consumed, not an extra: the retired key must not be rewritten forever.
    expect(doc?.extras).toEqual({});
    // And not re-emitted on save.
    expect(serializeSettings(doc!)).not.toContain("experimentRunPresets");
  });

  it("v5 graduation: a stored true enables the Run plugin (preserves prior state)", () => {
    // Plugins default OFF, so an experiment-ON user's Run must be carried
    // over explicitly or it would vanish.
    const doc = hydrateSettings(JSON.stringify({ experimentRunPresets: true }));
    expect(doc?.settings.plugins.enabled["keepdeck.run"]).toBe(true);
  });

  it("v5 graduation: an absent flag leaves the Run plugin unset (default off)", () => {
    const doc = hydrateSettings(JSON.stringify({}));
    expect(doc?.settings.plugins.enabled["keepdeck.run"]).toBeUndefined();
  });

  it("v5 graduation: an explicit plugins.enabled entry outranks the retired flag", () => {
    const doc = hydrateSettings(
      JSON.stringify({
        experimentRunPresets: false,
        plugins: { enabled: { "keepdeck.run": true } },
      }),
    );
    expect(doc?.settings.plugins.enabled["keepdeck.run"]).toBe(true);
  });

  it("a malformed value degrades ONLY its own key", () => {
    // The file is hand-editable: one typo must not reset the other settings.
    const doc = hydrateSettings(
      JSON.stringify({
        defaultAgent: 7, // not even a string
        scrollback: 50_000, // fine
      }),
    );
    expect(doc?.settings).toEqual({ ...DEFAULT_SETTINGS, scrollback: 50_000 });
  });

  it("keeps an unknown defaultAgent id — the id set is open", () => {
    // Agents come from plugins; hydration cannot know the catalog. An absent
    // plugin's id just loses the picker vote (defaultAgentType snaps away).
    const doc = hydrateSettings(JSON.stringify({ defaultAgent: "gemini" }));
    expect(doc?.settings.defaultAgent).toBe("gemini");
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

  it("a null defaultAgent (older document) degrades to the default", () => {
    const doc = hydrateSettings(JSON.stringify({ defaultAgent: null }));
    expect(doc?.settings.defaultAgent).toBe(DEFAULT_SETTINGS.defaultAgent);
  });

  it("defaultYolo stays sparse at its default and degrades a non-boolean", () => {
    expect(serializeSettings(defaultSettingsDocument())).not.toContain(
      "defaultYolo",
    );
    const armed = defaultSettingsDocument();
    armed.settings.defaultYolo = true;
    expect(JSON.parse(serializeSettings(armed)).defaultYolo).toBe(true);
    // Hand-editable file: a typo'd value falls back to off, not to garbage.
    const doc = hydrateSettings(JSON.stringify({ defaultYolo: "on" }));
    expect(doc?.settings.defaultYolo).toBe(false);
  });

});

describe("hydrateSettings — plugins bag", () => {
  it("defaults to empty enabled/values maps when the field is absent", () => {
    const doc = hydrateSettings("{}");
    expect(doc?.settings.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
  });

  it("reads enabled flags and per-plugin values verbatim", () => {
    const doc = hydrateSettings(
      JSON.stringify({
        plugins: {
          enabled: { git: true, notes: false },
          values: { git: { remote: "origin", depth: 3 } },
        },
      }),
    );
    expect(doc?.settings.plugins).toEqual({
      enabled: { git: true, notes: false },
      values: { git: { remote: "origin", depth: 3 } },
      consented: {},
    });
  });

  it("a malformed entry degrades on its own, keeping its siblings", () => {
    // The file is hand-editable: one bad plugin id must not wipe the rest.
    const doc = hydrateSettings(
      JSON.stringify({
        plugins: {
          enabled: { git: true, bad: "not a bool" },
          values: { git: { x: 1 }, bad: "not an object" },
        },
      }),
    );
    expect(doc?.settings.plugins).toEqual({
      enabled: { git: true },
      values: { git: { x: 1 } },
      consented: {},
    });
  });

  it("a non-object plugins field degrades to defaults instead of rejecting the document", () => {
    const doc = hydrateSettings(
      JSON.stringify({ plugins: "not an object", scrollback: 20_000 }),
    );
    expect(doc?.settings.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
    expect(doc?.settings.scrollback).toBe(20_000); // rest of the doc survives
  });

  it("an all-malformed plugins bag round-trips sparsely (no synthesized key)", () => {
    // Degrading to an EMPTY bag must not itself count as "the user set this" —
    // otherwise every load-then-save would inject a fresh, pointless key.
    const doc = hydrateSettings(
      JSON.stringify({ plugins: { enabled: { x: "nope" } } }),
    )!;
    expect(serializeSettings(doc)).not.toContain('"plugins"');
  });
});

describe("hydrateSettings — notifications bag", () => {
  it("defaults when the field is absent, keeping the default's identity", () => {
    const doc = hydrateSettings("{}")!;
    expect(doc.settings.notifications).toBe(DEFAULT_SETTINGS.notifications);
  });

  it("reads a stored mode and enabled flag", () => {
    const doc = hydrateSettings(
      JSON.stringify({ notifications: { enabled: false, mode: "app" } }),
    );
    expect(doc?.settings.notifications).toEqual({
      enabled: false,
      mode: "app",
      mutedPlugins: [],
    });
  });

  it("a malformed field degrades alone, keeping its siblings", () => {
    const doc = hydrateSettings(
      JSON.stringify({
        notifications: {
          enabled: "nope",
          mode: "system",
          mutedPlugins: ["keepdeck.git", 7],
        },
      }),
    );
    expect(doc?.settings.notifications).toEqual({
      enabled: true,
      mode: "system",
      mutedPlugins: ["keepdeck.git"],
    });
  });

  it("an unknown mode falls back to the default", () => {
    const doc = hydrateSettings(
      JSON.stringify({ notifications: { mode: "carrier-pigeon" } }),
    )!;
    expect(doc.settings.notifications).toBe(DEFAULT_SETTINGS.notifications);
  });

  it("an all-default bag round-trips sparsely (no synthesized key)", () => {
    const doc = hydrateSettings(
      JSON.stringify({ notifications: { enabled: true, mutedPlugins: [] } }),
    )!;
    expect(serializeSettings(doc)).not.toContain('"notifications"');
  });

  it("a non-default bag never aliases the shared default mutedPlugins array", () => {
    // An in-place mutation of a live bag must not poison the process-wide
    // default (readPlugins builds fresh maps for the same reason).
    const doc = hydrateSettings(JSON.stringify({ notifications: { mode: "app" } }))!;
    expect(doc.settings.notifications.mutedPlugins).toEqual([]);
    expect(doc.settings.notifications.mutedPlugins).not.toBe(
      DEFAULT_SETTINGS.notifications.mutedPlugins,
    );
  });

  it("round-trips a changed bag losslessly", () => {
    const doc = defaultSettingsDocument();
    doc.settings.notifications = {
      enabled: true,
      mode: "system",
      mutedPlugins: ["keepdeck.run"],
    };
    expect(hydrateSettings(serializeSettings(doc))).toEqual(doc);
  });

  it("withPluginMuted adds once, removes cleanly, and never mutates the input", () => {
    const prefs = { enabled: true, mode: "system-and-app" as const, mutedPlugins: ["a"] };
    const muted = withPluginMuted(withPluginMuted(prefs, "b", true), "b", true);
    expect(muted.mutedPlugins).toEqual(["a", "b"]); // dedup: no stacking
    expect(withPluginMuted(muted, "b", false).mutedPlugins).toEqual(["a"]);
    expect(withPluginMuted(prefs, "a", false).mutedPlugins).toEqual([]);
    expect(prefs.mutedPlugins).toEqual(["a"]); // input untouched
  });
});

describe("serializeSettings", () => {
  it("pure defaults write only the version markers — sparse by design", () => {
    expect(serializeSettings(defaultSettingsDocument())).toBe(
      JSON.stringify({ version: SETTINGS_VERSION, minVersion: 1 }),
    );
  });

  it("writes only the keys that differ from their defaults", () => {
    const doc = defaultSettingsDocument();
    doc.settings.defaultAgent = "codex";
    const out = JSON.parse(serializeSettings(doc));
    expect(out).toEqual({
      version: SETTINGS_VERSION,
      minVersion: 1,
      defaultAgent: "codex",
    });
  });

  it("quarantines a settings file whose floor is above this build", () => {
    expect(
      hydrateSettings(
        JSON.stringify({ version: 99, minVersion: 99, scrollback: 1 }),
      ),
    ).toBeNull();
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

describe("schema revisions", () => {
  it("a v1 file reads tolerantly and upgrades to the current revision on save", () => {
    const doc = hydrateSettings(JSON.stringify({ version: 1, scrollback: 20_000 }))!;
    const out = JSON.parse(serializeSettings(doc));
    expect(out.version).toBe(SETTINGS_VERSION);
    expect(out.scrollback).toBe(20_000);
  });

  it("a v3 file (pre plugin system) reads cleanly and upgrades without inventing a plugins key", () => {
    const doc = hydrateSettings(
      JSON.stringify({ version: 3, minVersion: 1, scrollback: 20_000 }),
    )!;
    expect(doc.settings.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
    const out = JSON.parse(serializeSettings(doc));
    expect(out.version).toBe(SETTINGS_VERSION);
    expect(out).not.toHaveProperty("plugins");
  });
});
