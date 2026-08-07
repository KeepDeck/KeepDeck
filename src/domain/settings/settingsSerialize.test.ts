import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  defaultSettingsDocument,
  serializeSettings,
  withSettings,
  type Settings,
} from "./settings";
import {
  NON_DEFAULT,
  SETTINGS_KEYS,
  restore,
  wrongShapeFor,
} from "./settings.testSupport";

/** What a saved document contains. */

const saved = (doc: Parameters<typeof serializeSettings>[0]) =>
  JSON.parse(serializeSettings(doc)) as Record<string, unknown>;

const chose = (patch: Partial<Settings>) =>
  withSettings(defaultSettingsDocument(), patch);

describe("serializeSettings", () => {
  it("a document with no decisions writes only the version markers", () => {
    expect(serializeSettings(defaultSettingsDocument())).toBe(
      JSON.stringify({ version: SETTINGS_VERSION, minVersion: 1 }),
    );
  });

  it("writes exactly the keys that were chosen", () => {
    expect(saved(chose({ defaultAgent: "codex" }))).toEqual({
      version: SETTINGS_VERSION,
      minVersion: 1,
      defaultAgent: "codex",
    });
  });

  it("stamps this build's revision over an older document's", () => {
    const out = saved(restore(JSON.stringify({ version: 1, scrollback: 20_000 })));
    expect(out.version).toBe(SETTINGS_VERSION);
    expect(out.scrollback).toBe(20_000);
  });

  it("a pre-plugin-system document gains no plugins key", () => {
    const doc = restore(JSON.stringify({ version: 3, minVersion: 1, scrollback: 20_000 }));
    expect(doc.settings.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
    expect(saved(doc)).not.toHaveProperty("plugins");
  });

  it("writes unknown keys back verbatim, before the settings", () => {
    const out = saved(
      restore(JSON.stringify({ version: 1, scrollback: 20_000, futureToggle: { n: 1 } })),
    );
    expect(out.futureToggle).toEqual({ n: 1 });
    expect(out.scrollback).toBe(20_000);
  });

  it("lists keys in table order, whatever order they were chosen in", () => {
    // A stable order keeps the hand-editable file readable and its diffs small.
    const out = serializeSettings(
      chose({ mcpServer: true, defaultYolo: true, scrollback: 20_000 }),
    );
    expect(Object.keys(JSON.parse(out))).toEqual([
      "version",
      "minVersion",
      "defaultYolo",
      "scrollback",
      "mcpServer",
    ]);
  });
});

describe("a chosen value survives a change of default", () => {
  it("keeps a stored value that merely EQUALS today's default", () => {
    // The point of storing decisions rather than differences: sparse storage
    // cannot tell "never chosen" from "chosen, and it matches today's default".
    const out = saved(restore('{"usageDisplay":"used","dockMode":"docked"}'));
    expect(out.usageDisplay).toBe("used");
    expect(out.dockMode).toBe("docked");
  });

  it("survives repeated load→save cycles unchanged — a fixed point", () => {
    // The bug this replaces: the second save dropped what the first wrote, so
    // a file quietly shed the user's choices one launch at a time.
    const first = serializeSettings(
      restore(
        '{"minimizeStyle":"tray","notifications":{"enabled":true,"mode":"system-and-app","mutedPlugins":[]},"plugins":{"enabled":{},"values":{},"consented":{}}}',
      ),
    );
    const second = serializeSettings(restore(first));
    expect(second).toBe(first);
    expect(JSON.parse(second)).toMatchObject({
      minimizeStyle: "tray",
      notifications: { enabled: true, mode: "system-and-app", mutedPlugins: [] },
      plugins: { enabled: {}, values: {}, consented: {} },
    });
  });

  it("a later build that flips the default does NOT override the user", () => {
    // Simulate tomorrow's release: the file chose `tray`, and `tray` is today's
    // default. If the save dropped it, a build defaulting to `none` would
    // silently change the user's deck.
    const stored = serializeSettings(restore('{"minimizeStyle":"tray"}'));
    expect(JSON.parse(stored).minimizeStyle).toBe("tray");
    expect(restore(stored).settings.minimizeStyle).toBe("tray");
  });

  it("a value the file carried but we could not use is NOT written back", () => {
    // Re-writing garbage as a synthesized default would grow the file on every
    // load while recording no decision at all.
    const out = serializeSettings(restore('{"dockMode":"sideways","mcpServer":"yes"}'));
    expect(out).not.toContain("dockMode");
    expect(out).not.toContain("mcpServer");
  });
});

describe("every setting, by construction", () => {
  it("has a sample that really differs from its default", () => {
    // Without this the properties below could pass vacuously.
    for (const key of SETTINGS_KEYS) {
      expect(NON_DEFAULT[key], key).not.toEqual(DEFAULT_SETTINGS[key]);
    }
  });

  it("survives a write → read round trip", () => {
    for (const key of SETTINGS_KEYS) {
      const back = restore(serializeSettings(chose({ [key]: NON_DEFAULT[key] })));
      expect(back.settings[key], key).toEqual(NON_DEFAULT[key]);
    }
  });

  it("is written when chosen, even at its default value", () => {
    for (const key of SETTINGS_KEYS) {
      expect(saved(chose({ [key]: DEFAULT_SETTINGS[key] })), key).toHaveProperty(key);
    }
  });

  it("round-trips a chosen default-valued value, twice", () => {
    // The composite keys are the ones that used to fail here: their readers
    // reported an all-default bag as unusable, so the key was erased.
    for (const key of SETTINGS_KEYS) {
      const first = serializeSettings(chose({ [key]: DEFAULT_SETTINGS[key] }));
      expect(serializeSettings(restore(first)), key).toBe(first);
    }
  });

  it("rejects a value of the wrong shape", () => {
    for (const key of SETTINGS_KEYS) {
      const doc = restore(JSON.stringify({ [key]: wrongShapeFor(key) }));
      expect(doc.settings[key], key).toEqual(DEFAULT_SETTINGS[key]);
      expect(doc.chosen, key).not.toHaveProperty(key);
    }
  });
});
